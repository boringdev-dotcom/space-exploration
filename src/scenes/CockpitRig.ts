import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import {
  createEnginePlume,
  type EnginePlume,
} from "../util/enginePlume";
import {
  Tween,
  damp,
  easeInOutCubic,
  noise1D,
  smoothstep,
} from "../util/feel";
import type { ShipState } from "./FlightDynamics";

const ARTEMIS_GLB_URL =
  "/models/rockets/artemis_ii_-_space_launch_system_sls.glb";

/**
 * Local-space camera offsets for each view mode. The ship anchor is at the
 * origin of the rig group, looking down -Z. Cockpit places the camera at the
 * pilot seat (slightly forward of, and above, the rocket's center). Chase
 * pulls the camera back along +Z and up.
 *
 * These are tuned to feel cinematic; both views frame the destination ahead
 * along -Z with the rocket either invisible (cockpit) or filling the lower
 * third (chase).
 */
const COCKPIT_OFFSET = new THREE.Vector3(0, 0.0, 0.0);
// Mission scale is 1 unit = 100 km. The rocket is rendered at a "cinematic"
// 0.5-unit height. Chase + external offsets are split into a ship-local
// "anti-forward" component (CHASE_BACK) and a world-up vertical component
// (CHASE_UP_WORLD) so the camera always sits ABOVE the horizon — at the
// launch pad, where the rocket's nose points world-up, a pure ship-local
// offset would push the camera below ground.
const CHASE_BACK = 1.4;
const CHASE_UP_WORLD = 1.4;
const EXTERNAL_ANCHOR_BACK = 2.4;
const EXTERNAL_ANCHOR_UP_WORLD = 2.0;
/** Seconds of no mouse motion before the external cam re-anchors behind. */
const EXTERNAL_RECENTER_SECONDS = 6;

/** FOV per mode — chase is slightly narrower for a more "filmic" look. */
const COCKPIT_FOV = 72;
const CHASE_FOV = 64;
const EXTERNAL_FOV = 56;

export type ViewMode = "cockpit" | "chase" | "external";

interface CockpitRigOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

/**
 * Owns the camera-rig, the Artemis GLB (chase-cam hero), and the cockpit
 * splat (cockpit-cam interior) plus the engine plume. Drives the cinematic
 * 900ms toggle between cockpit and chase views. Reusable across scenes.
 *
 * The rig is added to a host scene as a `THREE.Group` at the origin. The
 * host (FlightScene/HangarScene) drives the rig with `update(dt, elapsed)`
 * and decides whether to apply additional transformations (e.g. flight shake
 * via the `cameraShakeOffset` parameter).
 */
export class CockpitRig {
  /** Root group added to the host scene. Origin = ship anchor. */
  readonly root = new THREE.Group();

  /** Sub-group holding the chase-cam hero (Artemis + plume). */
  private readonly chaseGroup = new THREE.Group();
  /** Sub-group holding the cockpit splat (parented to camera). */
  private readonly cockpitGroup = new THREE.Group();

  private artemis: THREE.Group | null = null;
  private artemisLoaded = false;
  private artemisLoadStarted = false;

  private cockpitSplat: SplatMesh | null = null;
  private cockpitSplatGroup = new THREE.Group();
  private cockpitSplatLoadId = 0;

  private plume: EnginePlume;

  /** Current/target view mode. */
  private _viewMode: ViewMode = "cockpit";
  /** 0 = cockpit, 1 = chase. Smoothly interpolates during a toggle. */
  private viewBlend = 0;
  private viewTween: Tween;

  /** Shake/idle scratch vectors (avoid per-frame allocation). */
  private readonly _scratchOffset = new THREE.Vector3();
  private readonly _scratchLookAt = new THREE.Vector3();
  private readonly _idleSwayPos = new THREE.Vector3();

  private readonly camera: THREE.PerspectiveCamera;

  /** Throttle/boost set by the host every frame; used to drive the plume. */
  private throttle = 1;
  private boost = 0;

  /** External shake offset added every frame, in camera-local space. */
  private extraShakeOffset = new THREE.Vector3();

  /** Head-look offsets (radians). Applied AFTER the lookAt baseline. */
  private headLookYaw = 0;
  private headLookPitch = 0;
  /** Last (yaw,pitch) snapshot so we can detect mouse-quiet periods. */
  private lastHeadLook = { yaw: 0, pitch: 0 };
  private headLookQuietSec = 0;

  /** Where the external camera is anchored in world space. */
  private readonly externalAnchor = new THREE.Vector3();

  /**
   * If set, the rig follows this ship's transform every frame: chase rocket
   * + plume snap to ship pose, and camera offsets are interpreted in
   * ship-local space. When unset, the rig falls back to the legacy
   * world-origin behaviour used by the cinematic FlightScene.
   */
  private shipState: ShipState | null = null;
  private readonly _scratchShipOffset = new THREE.Vector3();
  private readonly _scratchShipLook = new THREE.Vector3();

  constructor(opts: CockpitRigOpts) {
    this.camera = opts.camera;

    this.root.name = "cockpitRig";
    this.root.add(this.chaseGroup);
    this.cockpitGroup.add(this.cockpitSplatGroup);
    // The cockpit group is parented to the camera so its splat moves with
    // the player's head; we add it via the host scene + matrixAuto setup so
    // the camera can be reused across scenes.
    opts.scene.add(this.root);

    // Engine plume sits at the rocket's engine bell, oriented along -Y by
    // default. The Artemis GLB is rotated so its nose points -Z and tail
    // points +Z; we rotate the plume so its fire vector aligns with +Z (the
    // exhaust direction visible to the chase camera).
    // Plume is sized for ship-relative units. The Artemis GLB normalises
    // to 0.5 units tall (see loadArtemis) so we keep the plume in scale.
    this.plume = createEnginePlume({ length: 0.55, baseRadius: 0.05 });
    this.plume.group.rotation.x = -Math.PI / 2;
    this.plume.group.position.set(0, -0.04, 0.16);
    this.chaseGroup.add(this.plume.group);

    this.viewTween = new Tween(0.9, easeInOutCubic, (eased) => {
      this.viewBlend = this._viewMode === "chase" ? eased : 1 - eased;
    });

    void this.loadArtemis();
  }

  attachCockpitToCamera(): void {
    if (this.cockpitGroup.parent !== this.camera) {
      this.camera.add(this.cockpitGroup);
    }
  }

  detachCockpitFromCamera(): void {
    if (this.cockpitGroup.parent === this.camera) {
      this.camera.remove(this.cockpitGroup);
    }
  }

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  /** Cycle cockpit → chase → external → cockpit. */
  toggleView(): void {
    const next: Record<ViewMode, ViewMode> = {
      cockpit: "chase",
      chase: "external",
      external: "cockpit",
    };
    this.setView(next[this._viewMode]);
  }

  setView(mode: ViewMode, immediate = false): void {
    if (mode === this._viewMode && !immediate) return;
    const prev = this._viewMode;
    this._viewMode = mode;

    if (mode === "external") {
      this.dropExternalAnchor();
    }

    // Cockpit ↔ chase uses the existing 0..1 blend tween. Transitions to/
    // from external are hard cuts (with FOV easing handled in update).
    if (mode === "external" || prev === "external") {
      this.viewTween.cancel();
      this.viewBlend = mode === "external" || mode === "chase" ? 1 : 0;
      return;
    }

    if (immediate) {
      this.viewTween.cancel();
      this.viewBlend = mode === "chase" ? 1 : 0;
    } else {
      this.viewTween.start();
    }
  }

  /** Apply external camera shake on top of the rig motion (in camera-local space). */
  setExtraShake(offset: THREE.Vector3): void {
    this.extraShakeOffset.copy(offset);
  }

  /** Set throttle (0..2) and boost (0..1) so the plume reacts. */
  setThrottle(throttle: number, boost: number): void {
    this.throttle = Math.max(0, Math.min(2, throttle));
    this.boost = Math.max(0, Math.min(1, boost));
  }

  /**
   * Head-look offsets (radians). Mouse-driven; applied on top of the rig's
   * baseline camera orientation each frame so the player can look around the
   * cabin without affecting ship heading. Values come from `FlightInput`.
   */
  setHeadLook(yaw: number, pitch: number): void {
    this.headLookYaw = yaw;
    this.headLookPitch = pitch;
  }

  /**
   * Tell the rig to track a ship transform. Call once per frame (or once on
   * setup if the ship reference is stable). The ship's `position` and
   * `quaternion` drive the rig's root, so the chase rocket + plume always
   * sit on the ship and camera offsets are interpreted ship-local.
   */
  followShip(ship: ShipState): void {
    this.shipState = ship;
    this.root.position.copy(ship.position);
    this.root.quaternion.copy(ship.quaternion);
  }

  /**
   * Drop a world-space anchor 18 units back-and-up from the ship's current
   * pose; used by external view to "let the rocket fly past". Re-called
   * automatically when the player has been idle for a while.
   */
  private dropExternalAnchor(): void {
    if (!this.shipState) return;
    // Horizontal anti-forward + world up. Always above the horizon, behind
    // the ship's horizontal flight direction. At the launch pad with nose
    // straight up we fall back to a stable side direction.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.shipState.quaternion,
    );
    const horizFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (horizFwd.lengthSq() < 0.001) {
      horizFwd.set(0, 0, 1);
    } else {
      horizFwd.normalize();
    }
    const back = horizFwd.negate().multiplyScalar(EXTERNAL_ANCHOR_BACK);
    const worldUp = new THREE.Vector3(0, 1, 0).multiplyScalar(
      EXTERNAL_ANCHOR_UP_WORLD,
    );
    this.externalAnchor.copy(this.shipState.position).add(back).add(worldUp);
  }

  /**
   * Drive the rig every frame from the host scene's update loop. `dt` and
   * `elapsed` are seconds.
   */
  update(dt: number, elapsed: number): void {
    this.viewTween.update(dt);

    // Smoothly drive the blend even when the tween isn't active so calls to
    // setView({immediate: true}) don't visibly jitter.
    const targetBlend = this._viewMode === "chase" ? 1 : 0;
    if (!this.viewTween.isActive) {
      this.viewBlend = damp(this.viewBlend, targetBlend, 8, dt);
    }

    const t = this.viewBlend;
    const easedT = easeInOutCubic(t);

    // Camera offset: lerp between cockpit (origin) and chase. The chase
    // offset is built fresh below (split into ship-local back + world-up)
    // so we just zero out _scratchOffset here for cockpit.
    this._scratchOffset.copy(COCKPIT_OFFSET);

    // Idle hand-held sway. Scaled DOWN inside cockpit (more grounded) and
    // UP in chase (more cinematic parallax).
    const swayAmp = 0.012 + 0.04 * easedT;
    this._idleSwayPos.set(
      noise1D(elapsed * 0.6, 1.7) * swayAmp,
      noise1D(elapsed * 0.5, 4.2) * swayAmp * 0.7,
      noise1D(elapsed * 0.4, 7.3) * swayAmp * 0.5,
    );

    // Track mouse quiet periods so the external cam can re-anchor on idle.
    const headLookDelta =
      Math.abs(this.headLookYaw - this.lastHeadLook.yaw) +
      Math.abs(this.headLookPitch - this.lastHeadLook.pitch);
    this.lastHeadLook.yaw = this.headLookYaw;
    this.lastHeadLook.pitch = this.headLookPitch;
    if (headLookDelta < 0.0008) {
      this.headLookQuietSec += dt;
    } else {
      this.headLookQuietSec = 0;
    }

    // Compose camera world position. When following a ship, all offsets are
    // rotated into the ship's local frame so the rig moves *with* the
    // rocket; when not following (legacy FlightScene), we fall back to
    // world-axis interpretation around the rig root.
    const ship = this.shipState;
    if (this._viewMode === "external" && ship) {
      // External: camera holds a world-space anchor near the ship; mouse
      // orbits the camera AROUND the ship (anchor relative to ship is
      // rotated by head-look). Look target = ship position so the rocket
      // stays framed regardless of orbit angle.
      if (this.headLookQuietSec > EXTERNAL_RECENTER_SECONDS) {
        this.dropExternalAnchor();
        this.headLookQuietSec = 0;
      }
      // Anchor offset relative to ship (world-space vector).
      this._scratchShipOffset
        .copy(this.externalAnchor)
        .sub(ship.position);
      // Mouse-driven orbital rotation of the offset around world Y for yaw
      // and the offset's local right-axis for pitch.
      _orbitYawAxisExt.set(0, 1, 0);
      this._scratchShipOffset.applyAxisAngle(
        _orbitYawAxisExt,
        this.headLookYaw,
      );
      _orbitPitchAxisExt
        .crossVectors(_orbitYawAxisExt, this._scratchShipOffset)
        .normalize();
      this._scratchShipOffset.applyAxisAngle(
        _orbitPitchAxisExt,
        this.headLookPitch,
      );

      this.camera.position
        .copy(ship.position)
        .add(this._scratchShipOffset)
        .add(this._idleSwayPos)
        .add(this.extraShakeOffset);
      this.camera.lookAt(ship.position);

      const targetFov = EXTERNAL_FOV;
      this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
      this.camera.updateProjectionMatrix();

      // Show chase rocket + plume; hide cockpit splat.
      this.chaseGroup.visible = true;
      this.cockpitGroup.visible = false;
      if (this.artemis) {
        const s = damp(this.artemis.scale.x, 1, 7, dt);
        this.artemis.scale.setScalar(s);
      }
      this.plume.group.visible = this.throttle > 0.05;
      if (this.plume.group.visible) {
        this.plume.setState(this.throttle, this.boost);
        this.plume.update(dt, elapsed);
      }
      return;
    }

    if (ship) {
      // Chase mode: build a "third-person flight sim" offset — horizontal
      // anti-forward (projection of ship-forward onto the horizontal
      // plane, negated) + world-up vertical bias. This way the camera
      // always sits *above* the horizon and *behind* the ship's flight
      // direction, regardless of whether the rocket is vertical (launch
      // pad) or horizontal (cruise).
      this._scratchShipOffset.set(0, 0, 0);
      if (easedT > 0.001) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(
          ship.quaternion,
        );
        // Project forward to horizontal plane (zero out Y) and normalize.
        const horizFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
        if (horizFwd.lengthSq() < 0.001) {
          // Ship pointing straight up/down — pick a stable side direction.
          horizFwd.set(0, 0, 1);
        } else {
          horizFwd.normalize();
        }
        // Mouse head-look orbits the back vector around world up (yaw)
        // and tips it up/down (pitch) — "move around the rocket".
        _orbitYawAxis.set(0, 1, 0);
        const back = horizFwd.negate().multiplyScalar(CHASE_BACK);
        back.applyAxisAngle(_orbitYawAxis, this.headLookYaw);
        const right = new THREE.Vector3()
          .crossVectors(back, _orbitYawAxis)
          .normalize();
        if (right.lengthSq() > 0) {
          back.applyAxisAngle(right, this.headLookPitch);
        }
        const worldUp = new THREE.Vector3(0, 1, 0).multiplyScalar(
          CHASE_UP_WORLD,
        );
        this._scratchShipOffset.copy(back).add(worldUp).multiplyScalar(easedT);
      }

      this.camera.position
        .copy(ship.position)
        .add(this._scratchShipOffset)
        .add(this._idleSwayPos)
        .add(this.extraShakeOffset);

      // Forward look target: project a point ahead of the ship in its local
      // -Z direction; chase view biases slightly downward and tracks the
      // ship centre regardless of orbital angle.
      const lookCockpit = this._scratchLookAt.set(0, 0, -10);
      const lookChase = new THREE.Vector3(0, -0.4, 0);
      const lookFinalLocal = lookCockpit.lerp(lookChase, easedT);
      this._scratchShipLook
        .copy(lookFinalLocal)
        .applyQuaternion(ship.quaternion)
        .add(ship.position);
      this.camera.lookAt(this._scratchShipLook);
    } else {
      // Legacy world-anchor behaviour for FlightScene's cinematic transit.
      this.camera.position
        .copy(this.root.position)
        .add(this._scratchOffset)
        .add(this._idleSwayPos)
        .add(this.extraShakeOffset);

      const lookCockpit = this._scratchLookAt.set(0, 0, -10);
      const lookChase = new THREE.Vector3(0, -0.4, 0);
      const lookFinal = lookCockpit.lerp(lookChase, easedT);
      this.camera.lookAt(lookFinal);
    }

    // In cockpit mode head-look becomes a rotation offset on top of the
    // lookAt so the player can pan around the cabin without changing the
    // ship's forward axis. In chase mode the same head-look values are
    // already consumed above as an orbital cam offset, so we skip it here.
    const headWeight = 1 - easedT;
    if (headWeight > 0.001) {
      this.camera.rotateY(this.headLookYaw * headWeight);
      this.camera.rotateX(this.headLookPitch * headWeight);
    }

    // FOV breathes between modes.
    const targetFov = COCKPIT_FOV + (CHASE_FOV - COCKPIT_FOV) * easedT;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
      this.camera.updateProjectionMatrix();
    }

    // Visibility: cross-fade rocket in/out. We keep both groups attached;
    // visibility flips at the midpoint to avoid double-render artifacts.
    const showChase = easedT > 0.5;
    this.chaseGroup.visible = easedT > 0.02;
    this.cockpitGroup.visible = easedT < 0.98;

    // Smoothly scale the rocket so it grows in instead of popping. Use a
    // per-frame damped scale rather than a hard switch.
    if (this.artemis) {
      const targetScale = showChase ? 1 : 0.001;
      const s = damp(this.artemis.scale.x, targetScale, 7, dt);
      this.artemis.scale.setScalar(s);
    }

    // Plume responds to throttle/boost; only worth updating when visible.
    this.plume.group.visible = easedT > 0.02 && this.throttle > 0.05;
    if (this.plume.group.visible) {
      this.plume.setState(this.throttle, this.boost);
      this.plume.update(dt, elapsed);
    }

    // Cockpit splat slow drift — "cabin breathing" — so the interior never
    // feels static. Only meaningful in cockpit mode.
    const cockpitWeight = 1 - easedT;
    if (this.cockpitSplatGroup && cockpitWeight > 0.001) {
      const breath = Math.sin(elapsed * 1.05) * 0.0035 * cockpitWeight;
      const swayRoll = noise1D(elapsed * 0.18, 12.5) * 0.012 * cockpitWeight;
      this.cockpitSplatGroup.position.z = breath;
      this.cockpitSplatGroup.rotation.z = swayRoll;
    }
  }

  /** Visibility helper — host can hide chase rocket entirely if desired. */
  setChaseVisible(visible: boolean): void {
    this.chaseGroup.visible = visible;
  }

  /**
   * Plug a generated cockpit splat into the rig. Pose options come from the
   * cockpit data record; visibility/parenting is managed automatically.
   */
  async setCockpitSplat(opts: {
    splatUrl: string;
    cameraOffset?: [number, number, number];
    splatRotation?: [number, number, number];
    splatScale?: number;
    tint?: [number, number, number];
    opacity?: number;
  }): Promise<void> {
    this.cockpitSplatLoadId++;
    const loadId = this.cockpitSplatLoadId;

    // Tear down any prior splat.
    if (this.cockpitSplat) {
      this.cockpitSplatGroup.remove(this.cockpitSplat);
      this.cockpitSplat.dispose?.();
      this.cockpitSplat = null;
    }

    const splat = new SplatMesh({ url: opts.splatUrl });
    // Spark's right-side-up convention (180° around X) — Marble exports Y-down.
    splat.quaternion.set(1, 0, 0, 0);
    if (opts.splatRotation) {
      const e = new THREE.Euler(...opts.splatRotation);
      const q = new THREE.Quaternion().setFromEuler(e);
      splat.quaternion.premultiply(q);
    }
    if (opts.cameraOffset) {
      splat.position.set(...opts.cameraOffset);
    }
    if (opts.splatScale) splat.scale.setScalar(opts.splatScale);

    // Marble bakes its own studio lighting into the splat. Pulling `recolor`
    // toward (0.4, 0.42, 0.48) tints every splat by that factor so the
    // interior reads as a moody dim cabin rather than a brightly-lit office.
    if (opts.tint) {
      splat.recolor.setRGB(opts.tint[0], opts.tint[1], opts.tint[2]);
    }
    if (opts.opacity !== undefined) {
      splat.opacity = opts.opacity;
    }

    // Render order so it always sits on top of the flight scene; depth test
    // off so we don't depth-fight the procedural skybox behind it.
    splat.renderOrder = 10;

    try {
      await splat.initialized;
      if (loadId !== this.cockpitSplatLoadId) {
        splat.dispose?.();
        return;
      }
      this.cockpitSplat = splat;
      this.cockpitSplatGroup.add(splat);
      this.attachCockpitToCamera();
    } catch (err) {
      console.warn("[CockpitRig] cockpit splat failed to load", err);
    }
  }

  /** Tune the cockpit splat tint at runtime (debug HUD). */
  setCockpitTint(r: number, g: number, b: number): void {
    if (this.cockpitSplat) {
      this.cockpitSplat.recolor.setRGB(r, g, b);
    }
  }

  /** Whether the Artemis GLB is attached and ready (for status surfacing). */
  get artemisReady(): boolean {
    return this.artemisLoaded;
  }

  dispose(): void {
    this.plume.dispose();
    if (this.artemis) {
      disposeObjectTree(this.artemis);
      this.chaseGroup.remove(this.artemis);
    }
    if (this.cockpitSplat) {
      this.cockpitSplatGroup.remove(this.cockpitSplat);
      this.cockpitSplat.dispose?.();
    }
    if (this.cockpitGroup.parent) {
      this.cockpitGroup.parent.remove(this.cockpitGroup);
    }
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  private async loadArtemis(): Promise<void> {
    if (this.artemisLoadStarted) return;
    this.artemisLoadStarted = true;
    try {
      // Cinematic 0.5-unit height (≈ 50 km of "scale" units; visible at the
      // chase distance without being absurdly large). Real Artemis would be
      // ~0.001 units tall — invisible. We fudge size for readability.
      const model = await loadNormalizedGltfModel(ARTEMIS_GLB_URL, 0.5);
      model.rotation.x = -Math.PI / 2;
      model.position.set(0, -0.06, 0);
      this.artemis = model;
      this.artemis.scale.setScalar(0.001);
      this.chaseGroup.add(this.artemis);
      this.artemisLoaded = true;
    } catch (err) {
      console.warn("[CockpitRig] Artemis GLB failed to load", err);
    }
  }

  /** Snapshot for the debug HUD. */
  getDebugSnapshot(): { mode: ViewMode; blend: number; artemisReady: boolean } {
    return {
      mode: this._viewMode,
      blend: this.viewBlend,
      artemisReady: this.artemisLoaded,
    };
  }
}

// Suppress unused import warnings for helpers that may be useful later.
void smoothstep;

/**
 * Build a chase-camera offset that orbits around the ship by `(yaw, pitch)`.
 * The base offset is the back-and-up CHASE_OFFSET; mouse-driven yaw rotates
 * around world up, and pitch rotates around the right axis post-yaw. Result
 * is in ship-local space, ready to be transformed by the ship's quaternion.
 */
const _orbitYawAxis = new THREE.Vector3(0, 1, 0);
// Separate scratch for the external camera so chase + external don't
// stomp each other when both fire in the same frame.
const _orbitYawAxisExt = new THREE.Vector3(0, 1, 0);
const _orbitPitchAxisExt = new THREE.Vector3(1, 0, 0);
