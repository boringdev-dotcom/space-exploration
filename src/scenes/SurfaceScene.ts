import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import type { Planet } from "../data/planets";
import type { SurfaceDebugSnapshot } from "../hud/debugHud";
import {
  ARTEMIS_ROCKET_GLB_URL,
  isMockSplatUrl,
} from "../data/assetUrls";
import { createStarfield } from "../util/starfield";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import { damp } from "../util/feel";

export type SurfaceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

type LockListener = (locked: boolean) => void;

export interface SurfaceRocketInteractionSnapshot {
  ready: boolean;
  loading: boolean;
  boarding: boolean;
  distance: number;
  inRange: boolean;
  hintVisible: boolean;
  boardRange: number;
  hintRange: number;
  currentPlanetId: string | null;
}

const ROCKET_LANDING_POSITION = new THREE.Vector3(5.6, 0, -9.2);
const ROCKET_BOARD_RANGE = 12;
const ROCKET_HINT_RANGE = 12;
const ROCKET_TARGET_DIAMETER = 5.25;

/** Tiny deterministic PRNG so each planet's procedural rockfield is stable. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Surface exploration scene — loads a Gaussian splat world via Spark.js
 * and lets the user walk around with first-person controls.
 */
export class SurfaceScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private spark: SparkRenderer;
  private canvas: HTMLCanvasElement;
  private controls: PointerLockControls;

  private splat: SplatMesh | null = null;
  private _status: SurfaceStatus = "idle";
  private _progress = 0;
  private _splatUrl: string | null = null;
  private _lastError: string | null = null;
  private lockListeners: LockListener[] = [];

  // Procedural fallback surface used when the planet's `splatUrl` still
  // points at the Spark sample splat (i.e. `worlds:mock` was used instead
  // of `worlds:generate`). A simple tinted ground plane + starfield beats
  // dropping the player inside a giant butterfly demo asset.
  private fallbackGroup: THREE.Group | null = null;

  // Touchdown spawn pose used to be persisted here so the player would
  // appear "wherever the ship landed". The ship's mission-space transform
  // isn't a usable surface-space transform — the Marble splat scan origin
  // sits at world (0, 0, 0) regardless of where the destination planet is
  // in mission space, and the camera's far plane is 1000 — so re-using the
  // mission pose put the camera completely outside the splat and nothing
  // rendered. We now always spawn at the Marble scan origin (see
  // `resetCameraPose`) and `setSpawnPose` is intentionally a no-op.

  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private moveUp = false;
  private moveDown = false;
  private sprint = false;

  // Smooth movement model (ported from gaussian-splat-character-controller).
  // Velocity is lerped toward the desired direction every frame using a
  // frame-rate-independent factor `1 - pow(smoothing, 0.116)`. Higher
  // `velocityXZSmoothing` = floatier; `accelerationTimeGrounded` further
  // damps the response to avoid jitter on quick taps.
  private readonly walkSpeed = 4.5;
  private readonly sprintMul = 2.2;
  private readonly verticalSpeed = 3.0;
  private readonly velocityXZSmoothing = 0.08;
  private readonly accelerationTimeGrounded = 0.025;
  private readonly velocityMin = 0.0001;
  private readonly horizontalVelocity = new THREE.Vector3();
  private verticalVelocity = 0;

  // Sprint FOV ramp. The base 75° matches Marble's official world viewer so
  // perspective and framing line up with the marble.worldlabs.ai preview the
  // user saw when they generated the world.
  private readonly normalFov = 75;
  private readonly sprintFov = 82;

  // Marble's viewer initialises the camera at the scan origin (0, 0, 0)
  // looking at (0, 0, -10), then — once the splat has finished loading —
  // animates it up to (0, 1, 0) looking at (0, 1, -10). That 1-unit lift
  // is what makes the framing look like "you're standing on the surface"
  // instead of "your eye is buried in the ground". We mirror that final
  // pose exactly so the spawn matches marble.worldlabs.ai byte-for-byte.
  private readonly eyeHeight = 1;

  // Reusable scratch vectors so we don't allocate per-frame.
  private readonly _camDir = new THREE.Vector3();
  private readonly _moveTarget = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _rocketWorldPos = new THREE.Vector3();

  // Landed rocket / repeat-flight interaction. This lives fully in
  // Marble/Spark surface space (near the scan origin), not mission space.
  private readonly rocketRoot = new THREE.Group();
  private readonly rocketPad = new THREE.Group();
  private rocketModel: THREE.Group | null = null;
  private rocketLoadId = 0;
  private rocketReady = false;
  private rocketLoading = false;
  private rocketDistance = Number.POSITIVE_INFINITY;
  private rocketInRange = false;
  private rocketHintVisible = false;
  private rocketBoarding = false;
  private rocketGlow = 0;
  private currentPlanetId: string | null = null;
  private readonly beaconLights: THREE.PointLight[] = [];

  constructor(spark: SparkRenderer, canvas: HTMLCanvasElement) {
    this.spark = spark;
    this.canvas = canvas;

    // Match Marble's official world viewer (marble.worldlabs.ai): a 75° FOV
    // camera at (0, eyeHeight, 0) looking down -Z toward an orbit target at
    // (0, eyeHeight, -10). Marble's near/far defaults work out to roughly
    // the same as Spark's reference viewer (0.01 near, 1000 far), so we
    // keep those.
    this.camera = new THREE.PerspectiveCamera(
      this.normalFov,
      window.innerWidth / window.innerHeight,
      0.01,
      1000,
    );
    this.camera.position.set(0, this.eyeHeight, 0);
    this.scene.add(this.camera);

    // Spark is added on enter() / removed on exit() because the same
    // SparkRenderer is shared with FlightScene (cockpit splat) and only one
    // scene can own it at a time.

    // Marble worlds bake their own lighting and atmospheric haze into the
    // splat colours, but Three.js lights are still needed for the landed GLB
    // rocket. Spark splat colours are baked, so these low-intensity lights
    // do not wash the WorldLabs scene.
    this.scene.add(new THREE.HemisphereLight(0xb9eaff, 0x1a120d, 0.58));
    const rocketKey = new THREE.DirectionalLight(0xffe3bd, 1.9);
    rocketKey.position.set(-4, 7, 5);
    this.scene.add(rocketKey);
    const rocketRim = new THREE.DirectionalLight(0x7de9ff, 1.35);
    rocketRim.position.set(5, 3.5, -5);
    this.scene.add(rocketRim);

    this.buildLandedRocketSite();
    this.scene.add(this.rocketRoot);

    this.controls = new PointerLockControls(this.camera, canvas);
    // Match the look feel of the reference character controller.
    this.controls.pointerSpeed = 0.7;

    this.controls.addEventListener("lock", () => this.emitLock(true));
    this.controls.addEventListener("unlock", () => this.emitLock(false));

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  enter(): void {
    if (this.spark.parent !== this.scene) this.scene.add(this.spark);
  }

  exit(): void {
    if (this.controls.isLocked) {
      this.controls.unlock();
    }
    this.cancelBoarding();
    this.resetMovement();
    if (this.spark.parent === this.scene) {
      this.scene.remove(this.spark);
    }
  }

  /** Load the planet's splat. Re-callable for new destinations. */
  async loadPlanet(planet: Planet): Promise<void> {
    this._status = "loading";
    this._progress = 0;
    this._splatUrl = planet.splatUrl;
    this._lastError = null;
    this.currentPlanetId = planet.id;
    this.cancelBoarding();
    this.resetMovement();
    this.resetRocketState();
    void this.loadRocketForSurface(++this.rocketLoadId);

    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }
    this.clearFallbackSurface();

    // Reset the camera onto the scan origin and zero out any leftover motion.
    this.resetCameraPose(planet);
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;

    // If the planet's splat still points at the Spark public sample
    // (e.g. butterfly.spz from `npm run worlds:mock`), don't render it —
    // drop in a planet-themed procedural ground + starfield instead so the
    // player doesn't touch down inside a butterfly.
    if (isMockSplatUrl(planet.splatUrl)) {
      console.log(
        "[SurfaceScene] planet uses mock splat URL; using procedural surface",
        planet.id,
        planet.splatUrl,
      );
      this.buildFallbackSurface(planet);
      this._progress = 1;
      this._status = "ready";
      return;
    }

    console.log("[SurfaceScene] loading splat", planet.id, planet.splatUrl);
    try {
      const splat = new SplatMesh({
        url: planet.splatUrl,
        onProgress: (e: ProgressEvent) => {
          if (e.total > 0) {
            this._progress = Math.min(0.99, e.loaded / e.total);
          }
        },
      });
      // Canonical "right-side-up" form used by Spark's official viewer
      // (examples/viewer/index.html). Quaternion (1, 0, 0, 0) is a 180°
      // rotation around X — Marble splats are exported Y-down, so this
      // flips them upright.
      splat.quaternion.set(1, 0, 0, 0);
      splat.position.set(0, 0, 0);
      splat.scale.setScalar(1.0);
      this.scene.add(splat);
      this.splat = splat;

      await splat.initialized;
      console.log(
        "[SurfaceScene] splat initialized",
        planet.id,
        "splatCount:",
        splat.numSplats,
      );

      // Marble's viewer never reorients the camera based on splat geometry —
      // it simply spawns at the scan origin looking down -Z. We mirror that
      // behaviour exactly (see resetCameraPose); calling lookAt against a
      // bbox centroid here was what produced the off-axis "weird" pose vs.
      // the marble.worldlabs.ai preview.

      this._progress = 1;
      this._status = "ready";
    } catch (err) {
      console.error("[SurfaceScene] failed to load splat", err);
      this._status = "error";
      this._lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  update(delta: number, _elapsed: number): void {
    this.updateRocketInteraction(delta, _elapsed);

    // Lerp factor based on `velocityXZSmoothing * accelerationTimeGrounded`.
    // The exponent 0.116 is what the reference controller uses to make the
    // response identical regardless of frame rate.
    const lerpFactor =
      1 -
      Math.pow(
        this.velocityXZSmoothing * this.accelerationTimeGrounded,
        0.116,
      );

    if (!this.controls.isLocked) {
      // Smoothly decelerate to zero when not actively driving — no sudden snap.
      this.horizontalVelocity.lerp(this._moveTarget.set(0, 0, 0), lerpFactor);
      this.verticalVelocity = THREE.MathUtils.lerp(this.verticalVelocity, 0, lerpFactor);
    } else {
      // Build a unit input vector in camera-yaw space.
      // (front: +z when forward, side: +x when left, then rotated by yaw.)
      const fz = Number(this.moveBackward) - Number(this.moveForward);
      const fx = Number(this.moveLeft) - Number(this.moveRight);
      const fy = Number(this.moveUp) - Number(this.moveDown);

      const speed = this.walkSpeed * (this.sprint ? this.sprintMul : 1);

      this._moveTarget.set(fx, 0, fz);
      if (this._moveTarget.lengthSq() > 0) this._moveTarget.normalize();
      this._moveTarget.multiplyScalar(speed);

      this.camera.getWorldDirection(this._camDir);
      const cameraYaw = Math.atan2(this._camDir.x, this._camDir.z);
      this._moveTarget.applyAxisAngle(this._up, cameraYaw).multiplyScalar(-1);

      this.horizontalVelocity.lerp(this._moveTarget, lerpFactor);

      const targetVerticalVelocity = fy * this.verticalSpeed;
      this.verticalVelocity = THREE.MathUtils.lerp(
        this.verticalVelocity,
        targetVerticalVelocity,
        lerpFactor,
      );
    }

    // Snap to zero below threshold to avoid endless tiny drift.
    if (Math.abs(this.horizontalVelocity.x) < this.velocityMin) this.horizontalVelocity.x = 0;
    if (Math.abs(this.horizontalVelocity.z) < this.velocityMin) this.horizontalVelocity.z = 0;
    if (Math.abs(this.verticalVelocity) < this.velocityMin) this.verticalVelocity = 0;

    // Apply translation in world space directly on the camera.
    this.camera.position.x += this.horizontalVelocity.x * delta;
    this.camera.position.z += this.horizontalVelocity.z * delta;
    this.camera.position.y += this.verticalVelocity * delta;

    // FOV ramp: lerp toward sprintFov when sprinting + moving.
    const horizontalSpeed = Math.hypot(this.horizontalVelocity.x, this.horizontalVelocity.z);
    const targetFov = this.sprint && horizontalSpeed > 0.5 ? this.sprintFov : this.normalFov;
    const fovT = Math.min(1, delta * 8);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, fovT);
      this.camera.updateProjectionMatrix();
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
    }
    this.clearFallbackSurface();
    this.clearRocketModel();
    this.scene.remove(this.rocketRoot);
    this.rocketPad.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
  }

  /* Status surfacing */
  get status(): SurfaceStatus {
    return this._status;
  }
  get progress(): number {
    return this._progress;
  }
  get isLocked(): boolean {
    return this.controls.isLocked;
  }

  getRocketInteraction(): SurfaceRocketInteractionSnapshot {
    return {
      ready: this.rocketReady,
      loading: this.rocketLoading,
      boarding: this.rocketBoarding,
      distance: this.rocketDistance,
      inRange: this.rocketInRange,
      hintVisible: this.rocketHintVisible,
      boardRange: ROCKET_BOARD_RANGE,
      hintRange: ROCKET_HINT_RANGE,
      currentPlanetId: this.currentPlanetId,
    };
  }

  requestBoarding(): boolean {
    if (!this.rocketReady || !this.rocketInRange) return false;
    this.rocketBoarding = true;
    if (this.controls.isLocked) this.controls.unlock();
    this.resetMovement();
    return true;
  }

  cancelBoarding(): void {
    this.rocketBoarding = false;
  }

  /** Snapshot used by the on-screen debug HUD. */
  getDebugSnapshot(): SurfaceDebugSnapshot {
    let bbox: THREE.Box3 | null = null;
    let splatCount: number | null = null;
    if (this.splat) {
      try {
        const b = this.splat.getBoundingBox?.(true);
        if (b && Number.isFinite(b.min.x) && !b.isEmpty()) bbox = b;
      } catch {
        bbox = null;
      }
      const splatAny = this.splat as unknown as {
        numSplats?: number;
        splats?: { numSplats?: number; lodSplats?: { numSplats?: number } };
      };
      splatCount =
        splatAny.numSplats ??
        splatAny.splats?.lodSplats?.numSplats ??
        splatAny.splats?.numSplats ??
        null;
    }
    return {
      status: this._status,
      progress: this._progress,
      isLocked: this.controls.isLocked,
      splatUrl: this._splatUrl,
      splatCount,
      splatPosition: this.splat ? this.splat.position.clone() : null,
      splatQuaternion: this.splat ? this.splat.quaternion.clone() : null,
      splatScale: this.splat ? this.splat.scale.clone() : null,
      bbox,
      lastError: this._lastError,
      splat: this.splat,
    };
  }

  /* Pointer lock plumbing for the HUD */

  requestPointerLock(): void {
    if (!this.controls.isLocked) {
      this.canvas.focus();
      this.controls.lock();
    }
  }

  onLockChange(cb: LockListener): void {
    this.lockListeners.push(cb);
  }

  private emitLock(locked: boolean): void {
    this.lockListeners.forEach((cb) => cb(locked));
  }

  /**
   * Receive the touchdown spawn pose from MissionScene. Kept on the public
   * API for compatibility with the existing handoff wiring, but it's a
   * no-op: the mission-space pose isn't a valid surface-space pose (see
   * the comment near the top of the class). The player always spawns at
   * the Marble scan origin so the splat renders correctly.
   */
  setSpawnPose(_pose: { position: THREE.Vector3; quaternion: THREE.Quaternion }): void {
    void _pose;
  }

  private resetCameraPose(_planet: Planet): void {
    // Marble's official viewer (marble.worldlabs.ai) settles the camera at
    // (0, 1, 0) looking at (0, 1, -10) once the splat has loaded. After our
    // OpenCV→OpenGL flip on the splat (quaternion 1, 0, 0, 0 — a 180°
    // rotation around X), this is exactly the framing the Marble preview
    // shows. Reproducing it byte-for-byte gives us the same hero view the
    // user saw when they generated the world.
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.quaternion.identity();
    this.camera.lookAt(0, this.eyeHeight, -10);
  }

  /**
   * Build a procedural planet-themed surface to stand in for a missing
   * Marble splat. It's deliberately modest — a large tinted ground disc,
   * a few scattered boulders, and a starfield sky — but it reads as "you
   * landed on X" rather than "you landed inside a butterfly".
   */
  private buildFallbackSurface(planet: Planet): void {
    const group = new THREE.Group();
    group.name = `surface.fallback.${planet.id}`;

    const theme = planet.theme;
    const lightColor = new THREE.Color(theme.light);
    const midColor = new THREE.Color(theme.mid);
    const darkColor = new THREE.Color(theme.dark);

    // Ground: a large soft-tinted disc with a subtle radial gradient so
    // the horizon fades out rather than ending in a hard edge.
    const groundGeom = new THREE.CircleGeometry(420, 128);
    const groundColors = new Float32Array(groundGeom.attributes.position.count * 3);
    const pos = groundGeom.attributes.position;
    const nearTint = midColor.clone().lerp(lightColor, 0.25);
    const farTint = midColor.clone().lerp(darkColor, 0.55);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.min(1, Math.hypot(x, y) / 420);
      const jitter = 1 - Math.random() * 0.08;
      const c = nearTint.clone().lerp(farTint, r).multiplyScalar(jitter);
      groundColors[i * 3 + 0] = c.r;
      groundColors[i * 3 + 1] = c.g;
      groundColors[i * 3 + 2] = c.b;
    }
    groundGeom.setAttribute("color", new THREE.BufferAttribute(groundColors, 3));
    const groundMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = false;
    group.add(ground);

    // Scattered boulders — deterministic placement per-planet so repeat
    // visits look the same.
    const rng = mulberry32(hashString(planet.id));
    const rockMat = new THREE.MeshStandardMaterial({
      color: midColor.clone().multiplyScalar(0.85),
      roughness: 0.95,
      metalness: 0.03,
    });
    const rockGeom = new THREE.IcosahedronGeometry(1, 1);
    const rocks = new THREE.InstancedMesh(rockGeom, rockMat, 48);
    const rockMatrix = new THREE.Matrix4();
    const rockPos = new THREE.Vector3();
    const rockQuat = new THREE.Quaternion();
    const rockScale = new THREE.Vector3();
    for (let i = 0; i < rocks.count; i++) {
      // Spread rocks in a ring between 14 and 120 units so the spawn area
      // near the rocket pad stays clear.
      const a = rng() * Math.PI * 2;
      const radius = 14 + rng() * 106;
      rockPos.set(Math.cos(a) * radius, -0.25 + rng() * 0.35, Math.sin(a) * radius);
      rockQuat.setFromEuler(
        new THREE.Euler(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6),
      );
      const s = 0.4 + rng() * 1.6;
      rockScale.set(s, 0.65 * s, s);
      rockMatrix.compose(rockPos, rockQuat, rockScale);
      rocks.setMatrixAt(i, rockMatrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    group.add(rocks);

    // Sky: a large starfield dome tinted by the planet's glow colour so
    // Europa reads icy-blue, Mars reads salmon, Titan reads amber, etc.
    const stars = createStarfield({ count: 1800, radius: 520, size: 1.4 });
    const starMat = stars.material as THREE.PointsMaterial;
    starMat.color = lightColor.clone().lerp(new THREE.Color(0xffffff), 0.4);
    group.add(stars);

    // Subtle sky dome so it doesn't read as pure black — uses the
    // planet's `dark` theme colour on the inside of a large back-faced
    // sphere.
    const domeMat = new THREE.MeshBasicMaterial({
      color: darkColor,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), domeMat);
    dome.position.y = 0;
    group.add(dome);

    this.scene.add(group);
    this.fallbackGroup = group;
  }

  private clearFallbackSurface(): void {
    if (!this.fallbackGroup) return;
    this.scene.remove(this.fallbackGroup);
    this.fallbackGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
    this.fallbackGroup = null;
  }

  private buildLandedRocketSite(): void {
    this.rocketRoot.name = "surface.landedRocket";
    this.rocketRoot.position.copy(ROCKET_LANDING_POSITION);
    this.rocketRoot.rotation.y = -0.32;
    this.rocketRoot.visible = false;

    const scorchMat = new THREE.MeshBasicMaterial({
      color: 0x050404,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(3.8, 80), scorchMat);
    scorch.name = "surface.landedRocket.scorch";
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.012;
    this.rocketPad.add(scorch);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4cd6ff,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.95, 4.15, 96), ringMat);
    ring.name = "surface.landedRocket.padRing";
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.rocketPad.add(ring);

    const strutMat = new THREE.MeshBasicMaterial({
      color: 0xffba20,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    const strutGeom = new THREE.BoxGeometry(0.08, 0.018, 7.6);
    for (let i = 0; i < 4; i++) {
      const strut = new THREE.Mesh(strutGeom, strutMat);
      strut.rotation.y = (Math.PI / 4) + (i * Math.PI) / 2;
      strut.position.y = 0.045;
      this.rocketPad.add(strut);
    }

    const coreGlow = new THREE.PointLight(0x5fe9ff, 1.3, 9, 1.8);
    coreGlow.position.set(0, 0.45, 0);
    this.beaconLights.push(coreGlow);
    this.rocketPad.add(coreGlow);

    const beaconGeom = new THREE.SphereGeometry(0.12, 16, 10);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0x7df9ff,
      transparent: true,
      opacity: 0.78,
    });
    const beaconPositions: THREE.Vector3Tuple[] = [
      [3.3, 0.18, 3.3],
      [-3.3, 0.18, 3.3],
      [3.3, 0.18, -3.3],
      [-3.3, 0.18, -3.3],
    ];
    beaconPositions.forEach((pos) => {
      const beacon = new THREE.Mesh(beaconGeom, beaconMat);
      beacon.position.set(...pos);
      this.rocketPad.add(beacon);
      const light = new THREE.PointLight(0x7df9ff, 0.65, 5.5, 1.7);
      light.position.set(...pos);
      this.beaconLights.push(light);
      this.rocketPad.add(light);
    });

    this.rocketRoot.add(this.rocketPad);
  }

  private resetRocketState(): void {
    this.rocketReady = false;
    this.rocketLoading = true;
    this.rocketDistance = Number.POSITIVE_INFINITY;
    this.rocketInRange = false;
    this.rocketHintVisible = false;
    this.rocketGlow = 0;
    this.rocketRoot.visible = false;
    this.clearRocketModel();
  }

  private async loadRocketForSurface(loadId: number): Promise<void> {
    try {
      const model = await loadNormalizedGltfModel(
        ARTEMIS_ROCKET_GLB_URL,
        ROCKET_TARGET_DIAMETER,
      );
      if (loadId !== this.rocketLoadId) {
        disposeObjectTree(model);
        return;
      }

      this.clearRocketModel();
      model.name = "surface.landedRocket.artemis";
      model.rotation.y = 0.18;
      const box = new THREE.Box3().setFromObject(model);
      if (Number.isFinite(box.min.y)) {
        model.position.y += -box.min.y + 0.04;
      }
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
      this.rocketModel = model;
      this.rocketRoot.add(model);
      this.rocketReady = true;
      this.rocketLoading = false;
      this.rocketRoot.visible = true;
    } catch (err) {
      if (loadId !== this.rocketLoadId) return;
      console.warn(
        "[SurfaceScene] landed rocket GLB failed; using procedural fallback",
        err,
      );
      this.clearRocketModel();
      const fallback = this.createFallbackRocketModel();
      this.rocketModel = fallback;
      this.rocketRoot.add(fallback);
      this.rocketReady = true;
      this.rocketLoading = false;
      this.rocketRoot.visible = true;
    }
  }

  private createFallbackRocketModel(): THREE.Group {
    const group = new THREE.Group();
    group.name = "surface.landedRocket.fallback";

    const white = new THREE.MeshStandardMaterial({
      color: 0xf1f6f8,
      roughness: 0.42,
      metalness: 0.18,
    });
    const orange = new THREE.MeshStandardMaterial({
      color: 0xd87528,
      roughness: 0.55,
      metalness: 0.08,
      emissive: 0x3a1404,
      emissiveIntensity: 0.18,
    });
    const black = new THREE.MeshStandardMaterial({
      color: 0x171b22,
      roughness: 0.45,
      metalness: 0.25,
    });
    const cyan = new THREE.MeshBasicMaterial({
      color: 0x7df9ff,
      transparent: true,
      opacity: 0.68,
    });

    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 4.1, 32), white);
    core.position.y = 2.25;
    group.add(core);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.92, 32), white);
    nose.position.y = 4.75;
    group.add(nose);

    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 3.7, 32), orange);
    tank.position.set(0, 1.95, 0.68);
    group.add(tank);

    const boosterGeom = new THREE.CylinderGeometry(0.22, 0.28, 3.35, 24);
    [-0.55, 0.55].forEach((x) => {
      const booster = new THREE.Mesh(boosterGeom, white);
      booster.position.set(x, 1.82, -0.08);
      group.add(booster);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.36, 24), white);
      cap.position.set(x, 3.67, -0.08);
      group.add(cap);
    });

    const bandGeom = new THREE.CylinderGeometry(0.535, 0.535, 0.12, 32);
    [1.1, 2.38, 3.52].forEach((y) => {
      const band = new THREE.Mesh(bandGeom, black);
      band.position.y = y;
      group.add(band);
    });

    const finGeom = new THREE.BoxGeometry(0.12, 0.55, 0.78);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeom, black);
      fin.position.set(Math.sin(i * Math.PI / 2) * 0.54, 0.38, Math.cos(i * Math.PI / 2) * 0.54);
      fin.rotation.y = i * Math.PI / 2;
      group.add(fin);
    }

    const window = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 12), cyan);
    window.position.set(0, 4.35, -0.37);
    window.scale.set(1, 0.62, 0.18);
    group.add(window);

    group.rotation.set(0, 0.18, 0);
    return group;
  }

  private clearRocketModel(): void {
    if (!this.rocketModel) return;
    this.rocketRoot.remove(this.rocketModel);
    disposeObjectTree(this.rocketModel);
    this.rocketModel = null;
  }

  private updateRocketInteraction(delta: number, elapsed: number): void {
    this.rocketRoot.getWorldPosition(this._rocketWorldPos);
    this.rocketDistance = this.camera.position.distanceTo(this._rocketWorldPos);
    this.rocketInRange = this.rocketReady && this.rocketDistance <= ROCKET_BOARD_RANGE;
    this.rocketHintVisible =
      this.rocketReady &&
      !this.rocketBoarding &&
      this.rocketDistance <= ROCKET_HINT_RANGE;

    const targetGlow = this.rocketInRange ? 1 : this.rocketHintVisible ? 0.45 : 0.12;
    this.rocketGlow = damp(this.rocketGlow, targetGlow, 5.5, delta);
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
    this.beaconLights.forEach((light, idx) => {
      const phase = 0.65 + 0.35 * Math.sin(elapsed * 2.8 + idx * 1.1);
      light.intensity = (0.22 + this.rocketGlow * 0.95) * (0.72 + pulse * 0.28) * phase;
    });

    this.rocketPad.scale.setScalar(1 + this.rocketGlow * 0.015);
  }

  private resetMovement(): void {
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.moveUp = false;
    this.moveDown = false;
    this.sprint = false;
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.rocketBoarding) return;
    switch (e.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = true;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = true;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = true;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = true;
        break;
      case "Space":
        this.moveUp = true;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.sprint = true;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.moveDown = true;
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = false;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = false;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = false;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = false;
        break;
      case "Space":
        this.moveUp = false;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.sprint = false;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.moveDown = false;
        break;
    }
  };
}
