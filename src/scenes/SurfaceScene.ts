import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import type { Planet } from "../data/planets";
import type { SurfaceDebugSnapshot } from "../hud/debugHud";

export type SurfaceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

type LockListener = (locked: boolean) => void;

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

    // No additional lighting or fog: Marble worlds bake their own lighting
    // and atmospheric haze into the splat colours. Adding scene lights or fog
    // would only desaturate / dim the photoreal output.

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

    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }

    // Reset the camera onto the scan origin and zero out any leftover motion.
    this.resetCameraPose(planet);
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;

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

  private readonly onKeyDown = (e: KeyboardEvent): void => {
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
