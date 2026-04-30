import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

import { ARTEMIS_ROCKET_GLB_URL } from "../data/assetUrls";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import {
  createEnginePlume,
  type EnginePlume,
} from "../util/enginePlume";
import {
  Tween,
  clamp,
  damp,
  dampVec3,
  easeInOutCubic,
  noise1D,
  smoothstep,
} from "../util/feel";
import type { ShipState } from "./FlightDynamics";

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
// Mission scale is 1 unit = 100 km. The Artemis chase rocket is rendered
// at a "cinematic" 1.2-unit height. Chase + external offsets are split
// into a ship-local "anti-forward" component (CHASE_BACK) and a world-up
// vertical component (CHASE_UP_WORLD) so the camera always sits ABOVE the
// horizon — at the launch pad, where the rocket's nose points world-up,
// a pure ship-local offset would push the camera below ground.
//
// MSFS-style framing: pull the chase camera well back so the rocket reads
// as a discrete object with context (Earth / destination / space) behind
// it, not a tight over-the-shoulder view. The plume opacity has been
// dialed down enough that we no longer need the lateral CHASE_SIDE bias
// to keep the lens clean.
const CHASE_BACK = 5.5;
const CHASE_UP_WORLD = 1.6;
const CHASE_SIDE = 0.0;
const EXTERNAL_ANCHOR_BACK = 6.5;
const EXTERNAL_ANCHOR_UP_WORLD = 2.4;
/**
 * Seconds of no mouse motion before the external cam re-anchors behind.
 * MSFS keeps the chase / external camera where you put it, so we disable
 * the auto-recentre. Players who want to reset can press `3` to re-enter
 * external mode (which calls `dropExternalAnchor`).
 */
const EXTERNAL_RECENTER_SECONDS = Number.POSITIVE_INFINITY;

/**
 * FOV per mode. Chase is now WIDER than cockpit for the cinematic
 * "third-person" feel; external sits between cockpit and chase so it
 * reads as a slightly telephoto cinematic shot.
 */
const COCKPIT_FOV = 70;
const CHASE_FOV = 75;
const EXTERNAL_FOV = 65;

/** Mouse-wheel zoom range for chase / external. 1.0 = base distance. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

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

  /** Current view mode (post-transition target). */
  private _viewMode: ViewMode = "cockpit";
  /** Mode being transitioned away from. Equals `_viewMode` when settled. */
  private _prevViewMode: ViewMode = "cockpit";
  /** 0 = at prev profile, 1 = at current profile. Drives the unified
   *  position+lookAt+FOV crossfade across all three view modes. */
  private viewT = 1;
  /** Length of the crossfade in seconds. */
  private static readonly VIEW_TRANSITION_SEC = 1.2;
  /** Legacy 0..1 chase-blend retained for callers that read it; equals
   *  the crossfade-weighted weight of `chase` against `cockpit`. */
  private viewBlend = 0;

  /** Cinematic cockpit fade-in. While < 1, the cockpit splat opacity is
   *  multiplied by this; used by the opening exterior → cockpit handoff. */
  private cockpitFadeIn = 1;
  private cockpitFadeTween: Tween | null = null;
  /** Target cockpit splat opacity (set by setCockpitSplat). */
  private cockpitTargetOpacity = 1;

  /** Shake/idle scratch vectors (avoid per-frame allocation). */
  private readonly _scratchLookAt = new THREE.Vector3();
  private readonly _idleSwayPos = new THREE.Vector3();
  /** Profile blend scratch — never mutated outside {@link update}. */
  private readonly _scratchPrevPos = new THREE.Vector3();
  private readonly _scratchPrevLook = new THREE.Vector3();
  private readonly _scratchCurPos = new THREE.Vector3();
  private readonly _scratchCurLook = new THREE.Vector3();
  /**
   * Smoothed cockpit-camera pose. Cockpit view is the player's head — even
   * sub-millisecond jitter from autopilot slerp + dynamics integration reads
   * as "shake" through the windshield. We critically damp the camera eye
   * and look target whenever the cockpit profile is dominant, which acts
   * as a high-frequency noise filter without introducing visible lag (the
   * lambda is high enough to track the autopilot's smooth heading changes
   * within a couple of frames).
   */
  private readonly _smoothCockpitEye = new THREE.Vector3();
  private readonly _smoothCockpitLook = new THREE.Vector3();
  private cockpitSmoothInitialized = false;

  /**
   * Smoothed ship pose used by the cockpit profile. Filters per-frame
   * quaternion / position chatter from the integrator + autopilot slerp at
   * its source — before it propagates into camera position / lookAt — so
   * the cockpit view reads as completely steady without introducing
   * perceptible lag (lambdas chosen to settle within ~3 frames at 60Hz).
   */
  private readonly _smoothShipPos = new THREE.Vector3();
  private readonly _smoothShipQuat = new THREE.Quaternion();
  /**
   * Forward vector cached from `_smoothShipQuat`. Pre-computed each frame
   * so cockpit eye and look point share a single low-pass filter — eye
   * is `_smoothShipPos`, look is `_smoothShipPos + _smoothShipForward * 10`.
   * Without this, a freshly-evaluated quat for each call could
   * (in principle) introduce sub-frame drift between the two.
   */
  private readonly _smoothShipForward = new THREE.Vector3(0, 0, -1);
  private smoothShipInitialized = false;

  /**
   * Cockpit "agility" signal (0..1) — driven by the host from the
   * player's pitch+yaw+roll rates. At rest the rig applies very strong
   * second-stage smoothing on the cockpit pose (λ≈32, kills sub-frame
   * jitter); during maneuvers it relaxes only slightly (λ≈26) so the
   * cabin splat stays glass-smooth without noticeable pilot lag.
   */
  private cockpitAgility = 0;

  /**
   * Smoothed camera up vector. Cockpit head-look pivots around camera.up,
   * so any per-frame chatter on up (caused by the cockpit-vs-world up
   * lerp tracking ship-roll) used to make the head-look pivot itself
   * wobble. Damping the up vector kills that.
   */
  private readonly _smoothCameraUp = new THREE.Vector3(0, 1, 0);

  /**
   * Mouse-wheel zoom multipliers per exterior view mode. Persist across
   * mode toggles so a player who pulled the chase camera way out doesn't
   * lose their framing the moment they pop into external and back.
   */
  private chaseZoom = 1.0;
  private externalZoom = 1.0;

  private readonly camera: THREE.PerspectiveCamera;

  /** Throttle/boost set by the host every frame; used to drive the plume. */
  private throttle = 1;
  private boost = 0;
  private plumeSpeedNorm = 0;
  /** Damped speed-norm used to fade cockpit windshield slightly at high speed. */
  private cockpitSpeedFade = 0;

  /** Speed-driven FOV bias (degrees, added on top of profile FOV). */
  private speedFovBias = 0;
  /** Transient boost-punch FOV pulse driven by {@link pulseBoostFov}. */
  private boostFovPulse = 0;
  private boostFovTween: Tween | null = null;
  /** Filtered yaw rate (-1..1) used for chase-camera roll-into-yaw bank. */
  private yawRateForBank = 0;

  /** Damped chase/external camera follower (B2 — camera lag). */
  private readonly _chaseFollowEye = new THREE.Vector3();
  private readonly _chaseFollowLook = new THREE.Vector3();
  private chaseFollowInitialized = false;

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

  /** Wheel listener bound at construction; removed in dispose. */
  private readonly _onWheel = (e: WheelEvent): void => {
    // Cockpit ignores wheel — the player's head can't dolly. Mission
    // controls only consume wheel while we're actually flying (i.e. the
    // rig is following a ship); otherwise let scroll bubble normally.
    if (this._viewMode === "cockpit" || !this.shipState) return;
    // exp-curve so each wheel notch is a constant percent of the current
    // distance. deltaY in pixels (~100 per notch) → ~9% per notch.
    const factor = Math.exp(e.deltaY * 0.0009);
    if (this._viewMode === "chase") {
      this.chaseZoom = clamp(this.chaseZoom * factor, ZOOM_MIN, ZOOM_MAX);
    } else {
      this.externalZoom = clamp(this.externalZoom * factor, ZOOM_MIN, ZOOM_MAX);
    }
    e.preventDefault();
  };

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
    this.plume = createEnginePlume({ length: 1.0, baseRadius: 0.1 });
    this.plume.group.rotation.x = -Math.PI / 2;
    this.plume.group.position.set(0, -0.1, 0.4);
    this.chaseGroup.add(this.plume.group);

    void this.loadArtemis();

    // Mouse-wheel zoom for chase + external views. We listen on window so
    // the canvas always wins regardless of stacking order (the HUD
    // overlays are pointer-events: none on their backgrounds, so wheel
    // events bubble up here).
    window.addEventListener("wheel", this._onWheel, { passive: false });
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

  /**
   * Current 0..1 weight of the cockpit profile in the active crossfade.
   * 1 = fully in cockpit, 0 = fully in chase/external. Hosts use this to
   * suppress effects (e.g. camera shake) that should not fire when the
   * camera is the pilot's head.
   */
  get cockpitWeight(): number {
    const tBlend = easeInOutCubic(this.viewT);
    return this.viewModeWeight("cockpit", tBlend);
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
    if (mode === this._viewMode && !immediate && this.viewT >= 1) return;

    if (mode === "external") {
      this.dropExternalAnchor();
    }

    // Set up a unified crossfade: the rig holds two ViewModes (`prev` and
    // `current`) and a 0..1 blend `viewT` that interpolates everything
    // between them — position, look target, FOV. This is used identically
    // for cockpit ↔ chase, cockpit ↔ external, chase ↔ external.
    if (immediate) {
      this._prevViewMode = mode;
      this._viewMode = mode;
      this.viewT = 1;
    } else {
      // If we're already mid-transition, snap "prev" to whatever we're
      // currently rendering so the new transition starts smoothly.
      this._prevViewMode = this._viewMode;
      this._viewMode = mode;
      this.viewT = 0;
    }
    // Clear the chase follower so the next exterior frame seeds from
    // the live target instead of inheriting a stale follow point from
    // the previous mode (would look like the camera "snaps" the moment
    // you toggle into chase).
    this.chaseFollowInitialized = false;
  }

  /** Apply external camera shake on top of the rig motion (in camera-local space). */
  setExtraShake(offset: THREE.Vector3): void {
    this.extraShakeOffset.copy(offset);
  }

  /**
   * Set throttle (0..2), boost (0..1), and optional speed factor (0..1)
   * so the engine plume can stretch with both thrust and current speed.
   */
  setThrottle(throttle: number, boost: number, speedNorm = 0): void {
    this.throttle = Math.max(0, Math.min(2, throttle));
    this.boost = Math.max(0, Math.min(1, boost));
    this.plumeSpeedNorm = Math.max(0, Math.min(1, speedNorm));
  }

  /**
   * Per-frame speed-driven FOV bias (degrees). Pushed on top of the
   * profile FOV so the camera widens slightly at high speed for the
   * "fast" sensation. Typical range: 0..4.
   */
  setSpeedFovBias(deg: number): void {
    this.speedFovBias = Math.max(0, Math.min(8, deg));
  }

  /**
   * Trigger a transient FOV pop (default +6° decaying over 0.4s) on
   * boost engage, à la Microsoft Flight Simulator.
   */
  pulseBoostFov(amount = 6, durationSec = 0.4): void {
    this.boostFovPulse = amount;
    this.boostFovTween?.cancel();
    this.boostFovTween = new Tween(durationSec, easeInOutCubic, (eased) => {
      this.boostFovPulse = amount * (1 - eased);
    }, () => {
      this.boostFovPulse = 0;
    });
    this.boostFovTween.start();
  }

  /**
   * Filtered yaw-rate command (-1..1) used to bank the chase camera
   * during turns. Visual only — the ship's quaternion is unaffected.
   */
  setYawRateForBank(yawRate: number): void {
    const clamped = Math.max(-1, Math.min(1, yawRate));
    // Mild low-pass (lambda 4) so the bank doesn't twitch on key-bumps.
    this.yawRateForBank = damp(this.yawRateForBank, clamped, 4, 1 / 60);
  }

  /**
   * Head-look offsets (radians). Mouse-driven; applied on top of the rig's
   * baseline camera orientation each frame so the player can look around the
   * cabin without affecting ship heading. Values come from `FlightInput`.
   *
   * Sub-millidegree values are dead-zoned to exact 0 so a never-quite-zero
   * spring tail can't keep firing `rotateOnWorldAxis` and producing
   * accumulator drift in the cockpit camera orientation.
   */
  setHeadLook(yaw: number, pitch: number): void {
    const dz = 0.0008;
    this.headLookYaw = Math.abs(yaw) < dz ? 0 : yaw;
    this.headLookPitch = Math.abs(pitch) < dz ? 0 : pitch;
  }

  /**
   * Player-input agility signal (0..1) — used to relax the cockpit
   * smoothing during intentional maneuvers and tighten it at rest. See
   * `cockpitAgility` for the math.
   */
  setCockpitAgility(value: number): void {
    this.cockpitAgility = Math.max(0, Math.min(1, value));
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
   * Drop a world-space anchor back-and-up from the ship's current pose;
   * used by external view to "let the rocket fly past". Re-called
   * automatically when the player has been idle for a while. `back` and
   * `up` override the default offsets — used by the opening cinematic to
   * pull the camera in close to the rocket on the launch pad.
   */
  dropExternalAnchor(back?: number, up?: number): void {
    if (!this.shipState) return;
    const backDist = back ?? EXTERNAL_ANCHOR_BACK;
    const upDist = up ?? EXTERNAL_ANCHOR_UP_WORLD;
    // Horizontal anti-forward + world up. Always above the horizon, behind
    // the ship's horizontal flight direction. At the launch pad with nose
    // straight up we fall back to a stable side direction.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.shipState.quaternion,
    );
    const horizFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (horizFwd.lengthSq() < 0.001) {
      // Ship pointing straight up (launch pad) — pick a stable side
      // direction so the camera is always to the SIDE of the rocket, not
      // above or below it.
      horizFwd.set(0, 0, 1);
    } else {
      horizFwd.normalize();
    }
    const backVec = horizFwd.negate().multiplyScalar(backDist);
    const worldUp = new THREE.Vector3(0, 1, 0).multiplyScalar(upDist);
    this.externalAnchor.copy(this.shipState.position).add(backVec).add(worldUp);
  }

  /**
   * Trigger a cinematic 0 → 1 cockpit splat fade-in, used by the opening
   * exterior-to-cockpit handoff. While the tween runs, the cockpit splat's
   * opacity is multiplied by `cockpitFadeIn`.
   */
  beginCinematicCockpitFade(durationSec = 1.4): void {
    this.cockpitFadeIn = 0;
    this.cockpitFadeTween?.cancel();
    this.cockpitFadeTween = new Tween(durationSec, easeInOutCubic, (eased) => {
      this.cockpitFadeIn = eased;
      if (this.cockpitSplat) {
        this.cockpitSplat.opacity = this.cockpitTargetOpacity * this.cockpitFadeIn;
      }
    }, () => {
      this.cockpitFadeIn = 1;
      if (this.cockpitSplat) {
        this.cockpitSplat.opacity = this.cockpitTargetOpacity;
      }
    });
    this.cockpitFadeTween.start();
  }

  /**
   * Drive the rig every frame from the host scene's update loop. `dt` and
   * `elapsed` are seconds.
   */
  update(dt: number, elapsed: number): void {
    // Smooth the ship pose AT THE SOURCE. Anything reading from the
    // smoothed pose (cockpit camera, chase target, external lookAt) gets
    // a low-pass-filtered ship transform that filters sub-frame
    // quaternion + position chatter without visible lag. λ chosen so the
    // pose settles within 2-3 frames at 60Hz.
    if (this.shipState) {
      if (!this.smoothShipInitialized) {
        this._smoothShipPos.copy(this.shipState.position);
        this._smoothShipQuat.copy(this.shipState.quaternion);
        this.smoothShipInitialized = true;
      } else {
        // Stronger low-pass than chase/external need: the cockpit splat is
        // millimetres from the eye, so any integrator + autopilot slerp
        // chatter reads as shake. λ high enough to track real turns within
        // a few frames, low enough to kill single-frame spikes.
        dampVec3(this._smoothShipPos, this.shipState.position, 18, dt);
        const sw = 1 - Math.exp(-14 * dt);
        this._smoothShipQuat.slerp(this.shipState.quaternion, sw);
        this._smoothShipQuat.normalize();
      }
      // Cache the forward derived from the smoothed quaternion. Cockpit
      // eye + look both reference this single vector, guaranteeing the
      // line-of-sight remains rock-solid even if the smoothed quat
      // wobbles by a millidegree per frame.
      this._smoothShipForward
        .set(0, 0, -1)
        .applyQuaternion(this._smoothShipQuat);
    }

    // Advance the unified mode crossfade. `viewT` runs 0 → 1 over
    // VIEW_TRANSITION_SEC; once settled we stop incrementing so the rig
    // sits exactly on the current profile.
    if (this.viewT < 1) {
      this.viewT = Math.min(
        1,
        this.viewT + dt / CockpitRig.VIEW_TRANSITION_SEC,
      );
      if (this.viewT >= 1) this._prevViewMode = this._viewMode;
    }
    const tBlend = easeInOutCubic(this.viewT);

    // Cinematic cockpit fade tween (used by the opening sequence).
    this.cockpitFadeTween?.update(dt);

    // Idle hand-held sway. Read from the mid-blend so the amplitude
    // matches the visual mode the camera is closer to.
    const chaseWeight = this.viewModeWeight("chase", tBlend);
    const externalWeight = this.viewModeWeight("external", tBlend);
    const cockpitWeight = this.viewModeWeight("cockpit", tBlend);

    // Legacy 0..1 chase blend retained for callers reading the field.
    this.viewBlend = chaseWeight + externalWeight;

    // Idle hand-held sway is reserved for the OUTSIDE views — chase and
    // external — where the cinematic parallax sells "camera operator
    // following the ship". Inside the cockpit the camera is the pilot's
    // head, which should be rock-steady so the player doesn't get sick.
    // Hard-zero sway when cockpit dominates so the blend never leaks
    // visible motion into the pilot's head.
    const swayAmp =
      cockpitWeight > 0.95
        ? 0
        : 0.025 * chaseWeight + 0.04 * externalWeight;
    if (swayAmp > 0.0001) {
      this._idleSwayPos.set(
        noise1D(elapsed * 0.6, 1.7) * swayAmp,
        noise1D(elapsed * 0.5, 4.2) * swayAmp * 0.7,
        noise1D(elapsed * 0.4, 7.3) * swayAmp * 0.5,
      );
    } else {
      this._idleSwayPos.set(0, 0, 0);
    }

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
    if (
      this._viewMode === "external" &&
      this.headLookQuietSec > EXTERNAL_RECENTER_SECONDS
    ) {
      this.dropExternalAnchor();
      this.headLookQuietSec = 0;
    }

    // Build the camera world transform by sampling each mode's profile and
    // blending. When `viewT === 1`, the result is purely the current mode.
    const ship = this.shipState;
    const prevPos = this._scratchPrevPos;
    const prevLook = this._scratchPrevLook;
    const curPos = this._scratchCurPos;
    const curLook = this._scratchCurLook;

    this.computeProfile(this._prevViewMode, ship, prevPos, prevLook);
    this.computeProfile(this._viewMode, ship, curPos, curLook);

    // Resolve the raw camera pose for this frame. Note: we mutate `prevPos`
    // and `prevLook` in-place because they're scratch buffers and we no
    // longer need their original "previous-mode" values after this lerp.
    const rawEye = prevPos.lerp(curPos, tBlend);
    const rawLook = this._scratchLookAt.copy(prevLook).lerp(curLook, tBlend);

    // Cockpit-pose damping: when the cockpit profile is the dominant
    // contribution, blend the raw pose into a smoothed pose at a high
    // lambda. This filters the sub-frame attitude noise that otherwise
    // reads as "the cockpit shakes a tiny bit during cruise". For chase /
    // external the camera is detached from the pilot's head so we use the
    // raw pose directly.
    if (cockpitWeight > 0.001 && ship) {
      if (!this.cockpitSmoothInitialized) {
        this._smoothCockpitEye.copy(rawEye);
        this._smoothCockpitLook.copy(rawLook);
        this.cockpitSmoothInitialized = true;
      } else {
        // Agility-aware second-stage smoothing (eye + look).
        // Keep the floor high: relaxing too far during maneuvers lets
        // autopilot / dynamics micro-jitter through the windshield (very
        // visible on a close splat). A narrow λ band stays smooth while
        // still tracking attitude within a frame or two at 60Hz.
        const lambda = 32 - 6 * this.cockpitAgility;
        dampVec3(this._smoothCockpitEye, rawEye, lambda, dt);
        dampVec3(this._smoothCockpitLook, rawLook, lambda, dt);
      }
      // Re-blend the smoothed cockpit pose with the raw exterior pose
      // proportionally to cockpit weight; in pure cockpit mode this
      // collapses to just the smoothed pose.
      const w = cockpitWeight;
      rawEye.lerp(this._smoothCockpitEye, w);
      rawLook.lerp(this._smoothCockpitLook, w);
    } else {
      // Mark unitialized so re-entering cockpit reseeds from the live pose.
      this.cockpitSmoothInitialized = false;
    }

    // Camera lag (B2): in chase + external the camera follower damps
    // toward the rigid target, producing a cinematic "swing" during
    // sharp turns. Cockpit is unaffected (the player IS the head).
    const exteriorWeight = chaseWeight + externalWeight;
    if (exteriorWeight > 0.001) {
      if (!this.chaseFollowInitialized) {
        this._chaseFollowEye.copy(rawEye);
        this._chaseFollowLook.copy(rawLook);
        this.chaseFollowInitialized = true;
      } else {
        // Position is slightly springier than look so the camera trails
        // during turns then catches up; look damps faster so the lens
        // always centres the rocket.
        dampVec3(this._chaseFollowEye, rawEye, 7, dt);
        dampVec3(this._chaseFollowLook, rawLook, 11, dt);
      }
      // Blend the followed pose proportionally to exterior weight.
      rawEye.lerp(this._chaseFollowEye, exteriorWeight);
      rawLook.lerp(this._chaseFollowLook, exteriorWeight);
    } else {
      this.chaseFollowInitialized = false;
    }

    this.camera.position
      .copy(rawEye)
      .add(this._idleSwayPos)
      .add(this.extraShakeOffset);

    // Pick a camera up vector. In COCKPIT view the camera IS the pilot's
    // head, so we anchor up to the ship's actual local-up — meaning the
    // player visually sees the world tilt when they roll. In chase /
    // external the up vector stays world-up so the camera horizon stays
    // level (the chase-bank effect handles the visual tilt instead).
    //
    // We damp the up vector toward its target so per-frame chatter on
    // ship-roll doesn't translate into a wobbling head-look pivot —
    // head-look rotates around camera.up, and a jittery up axis is
    // visible as cockpit "shake" even when the eye/look targets are
    // perfectly stable.
    if (cockpitWeight > 0.001 && ship) {
      _scratchShipUp.set(0, 1, 0).applyQuaternion(this._smoothShipQuat);
      _scratchCamUp.copy(_worldUp).lerp(_scratchShipUp, cockpitWeight);
      dampVec3(this._smoothCameraUp, _scratchCamUp, 12, dt);
      this.camera.up.copy(this._smoothCameraUp).normalize();
    } else {
      // Snap smoothed up back to world-Y in chase/external so re-entering
      // cockpit later doesn't carry a stale tilt.
      dampVec3(this._smoothCameraUp, _worldUp, 6, dt);
      this.camera.up.set(0, 1, 0);
    }

    this.camera.lookAt(rawLook);

    // FOV is part of the profile, plus a per-frame speed bias and an
    // optional transient boost punch so the camera widens at high speed.
    const prevFov = this.profileFov(this._prevViewMode);
    const curFov = this.profileFov(this._viewMode);
    const baseFov = prevFov + (curFov - prevFov) * tBlend;
    const targetFov = baseFov + this.speedFovBias + this.boostFovPulse;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
    this.boostFovTween?.update(dt);

    // Visual roll-into-yaw bank for chase + external (B3): rotate the
    // camera around its forward by a small angle proportional to the
    // (filtered) yaw rate. We do this AFTER the lookAt so the lens
    // banks visibly without affecting the ship's actual roll axis. Hard-
    // gated when cockpit is dominant so any blend leak can't introduce a
    // tilt to the pilot's head.
    if (
      exteriorWeight > 0.001 &&
      cockpitWeight < 0.05 &&
      Math.abs(this.yawRateForBank) > 0.001
    ) {
      const bankRad = -this.yawRateForBank * 0.25 * exteriorWeight; // ±0.25 rad ≈ ±14°
      // Camera-local Z is forward; rotateZ rotates around its own forward
      // axis ⇒ visual roll. Note: lookAt above already set the up vector
      // to world Y, so this banking sticks.
      this.camera.rotateZ(bankRad);
    }

    // Cockpit head-look: in cockpit mode the player can pan their head
    // freely. We apply yaw/pitch as quaternion offsets after the lookAt
    // so we don't induce ROLL drift. Weight by cockpit's blend share so
    // the head-look fades out as we move into chase / external.
    if (cockpitWeight > 0.001) {
      const yaw = this.headLookYaw * cockpitWeight;
      const pitch = this.headLookPitch * cockpitWeight;
      // Rotate around the camera's CURRENT up axis (which now matches the
      // ship's local up when in cockpit mode — set above before lookAt).
      // Skip the rotation when the value is exactly zero so we don't
      // accumulate float-precision noise during steady forward flight.
      if (yaw !== 0) this.camera.rotateOnWorldAxis(this.camera.up, yaw);
      if (pitch !== 0) this.camera.rotateX(pitch);
    }

    // Visibility:
    //   cockpit weight > 0 → cockpit splat visible
    //   chase + external weight > 0 → chase rocket + plume visible
    this.cockpitGroup.visible = cockpitWeight > 0.02;
    this.chaseGroup.visible = chaseWeight + externalWeight > 0.02;

    // Smoothly scale the rocket so it grows in instead of popping.
    if (this.artemis) {
      const targetScale = chaseWeight + externalWeight > 0.5 ? 1 : 0.001;
      const s = damp(this.artemis.scale.x, targetScale, 7, dt);
      this.artemis.scale.setScalar(s);
    }

    // Plume responds to throttle/boost; only worth updating when visible.
    this.plume.group.visible =
      this.chaseGroup.visible && this.throttle > 0.05;
    if (this.plume.group.visible) {
      this.plume.setState(this.throttle, this.boost, this.plumeSpeedNorm);
      this.plume.update(dt, elapsed);
    }

    // Cockpit windshield "transparency" pop at high speed (C4): the
    // splat fades from full opacity at rest to ~85% at top speed,
    // strengthening the sensation of motion through the glass.
    this.cockpitSpeedFade = damp(
      this.cockpitSpeedFade,
      this.plumeSpeedNorm,
      4,
      dt,
    );
    if (this.cockpitSplat) {
      const speedMul = 1 - 0.15 * this.cockpitSpeedFade;
      this.cockpitSplat.opacity =
        this.cockpitTargetOpacity * this.cockpitFadeIn * speedMul;
    }

    // Cockpit interior is rock-steady in cockpit view: a wobbling cabin
    // (previous "cabin breathing" + idle roll sway on the splat) reads as
    // motion sickness rather than realism, since the camera IS the pilot's
    // head. Pin the splat group to identity every frame so any leftover
    // transform from earlier behaviour is cleared.
    if (this.cockpitSplatGroup) {
      this.cockpitSplatGroup.position.set(0, 0, 0);
      this.cockpitSplatGroup.rotation.set(0, 0, 0);
    }
  }

  /** Mix weight (0..1) of `mode` for the current crossfade `t`. */
  private viewModeWeight(mode: ViewMode, t: number): number {
    const cur = this._viewMode === mode ? 1 : 0;
    const prev = this._prevViewMode === mode ? 1 : 0;
    return prev + (cur - prev) * t;
  }

  /** Per-mode FOV. */
  private profileFov(mode: ViewMode): number {
    return mode === "cockpit"
      ? COCKPIT_FOV
      : mode === "chase"
        ? CHASE_FOV
        : EXTERNAL_FOV;
  }

  /**
   * Compute camera world position + look target for `mode` into `outPos` /
   * `outLook`. Pure (no side effects) so two profiles can be blended.
   */
  private computeProfile(
    mode: ViewMode,
    ship: ShipState | null,
    outPos: THREE.Vector3,
    outLook: THREE.Vector3,
  ): void {
    if (mode === "cockpit") {
      if (ship) {
        // Use the SMOOTHED ship pose so per-frame integrator chatter
        // never reaches the pilot's eye. Eye and look both reference
        // `_smoothShipForward` (cached above from `_smoothShipQuat`)
        // so they share the same low-pass filter — the line-of-sight
        // direction can't drift relative to the eye position even by
        // a millidegree.
        outPos.copy(this._smoothShipPos);
        outLook
          .copy(this._smoothShipForward)
          .multiplyScalar(10)
          .add(this._smoothShipPos);
      } else {
        outPos.copy(this.root.position).add(COCKPIT_OFFSET);
        outLook.set(0, 0, -10);
      }
      return;
    }

    if (mode === "chase") {
      if (ship) {
        // Horizontal anti-forward + world-up offset, scaled by the
        // mouse-wheel-driven `chaseZoom`. CHASE_SIDE is now 0 (plume
        // dimmed enough that the lateral bias is no longer needed),
        // but we keep the math so future framing tweaks compose
        // cleanly.
        const fwd = _scratchFwd
          .set(0, 0, -1)
          .applyQuaternion(ship.quaternion);
        const horizFwd = _scratchHorizFwd.set(fwd.x, 0, fwd.z);
        if (horizFwd.lengthSq() < 0.001) {
          horizFwd.set(0, 0, 1);
        } else {
          horizFwd.normalize();
        }
        const back = _scratchBack
          .copy(horizFwd)
          .negate()
          .multiplyScalar(CHASE_BACK * this.chaseZoom);
        const sideAxis = _scratchRight
          .crossVectors(_worldUp, horizFwd)
          .normalize();
        const sideOffset = _scratchUp
          .copy(sideAxis)
          .multiplyScalar(CHASE_SIDE * this.chaseZoom);
        // Mouse head-look orbits the back vector around world up (yaw)
        // and tips it up/down (pitch).
        back.applyAxisAngle(_worldUp, this.headLookYaw);
        sideOffset.applyAxisAngle(_worldUp, this.headLookYaw);
        const right = _scratchExternalPitchAxis
          .crossVectors(back, _worldUp)
          .normalize();
        if (right.lengthSq() > 0) {
          back.applyAxisAngle(right, this.headLookPitch);
        }
        outPos
          .copy(ship.position)
          .add(back)
          .add(sideOffset)
          .add(
            _scratchExternalOffset.set(
              0,
              CHASE_UP_WORLD * this.chaseZoom,
              0,
            ),
          );
        // Look slightly AHEAD of the ship along its forward direction.
        // This makes turns feel cinematic — the camera leads the ship
        // through the bank instead of statically pointing at the centre
        // of mass, and reduces visual whip at high yaw rates.
        outLook
          .set(0, 0, -1.5)
          .applyQuaternion(ship.quaternion)
          .add(ship.position);
      } else {
        outPos.copy(this.root.position);
        outLook.set(0, -0.4, 0);
      }
      return;
    }

    // mode === "external"
    if (ship) {
      // Anchor offset relative to ship (world-space vector), scaled by the
      // mouse-wheel-driven `externalZoom` so the player can dolly in/out.
      const offset = _scratchExternalOffset
        .copy(this.externalAnchor)
        .sub(ship.position)
        .multiplyScalar(this.externalZoom);
      // Mouse-driven orbital rotation around world Y (yaw) + a pitch axis
      // computed from the offset.
      offset.applyAxisAngle(_worldUp, this.headLookYaw);
      const pitchAxis = _scratchExternalPitchAxis
        .crossVectors(_worldUp, offset)
        .normalize();
      if (pitchAxis.lengthSq() > 0) {
        offset.applyAxisAngle(pitchAxis, this.headLookPitch);
      }
      outPos.copy(ship.position).add(offset);
      outLook.copy(ship.position);
    } else {
      outPos.copy(this.externalAnchor);
      outLook.copy(this.root.position);
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
    this.cockpitTargetOpacity = opts.opacity ?? 1;
    splat.opacity = this.cockpitTargetOpacity * this.cockpitFadeIn;

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
    window.removeEventListener("wheel", this._onWheel);
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
      // Cinematic 1.2-unit height — large enough to read clearly from the
      // chase camera (which sits 2.6 back + 1.2 side + 1.8 up from the
      // ship). Real Artemis would be ~0.001 units tall at our scale.
      const model = await loadNormalizedGltfModel(ARTEMIS_ROCKET_GLB_URL, 1.2);
      model.rotation.x = -Math.PI / 2;
      model.position.set(0, -0.15, 0);
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
const _worldUp = new THREE.Vector3(0, 1, 0);
const _scratchFwd = new THREE.Vector3();
const _scratchHorizFwd = new THREE.Vector3();
const _scratchBack = new THREE.Vector3();
const _scratchRight = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();
const _scratchExternalOffset = new THREE.Vector3();
const _scratchExternalPitchAxis = new THREE.Vector3();
const _scratchShipUp = new THREE.Vector3();
const _scratchCamUp = new THREE.Vector3();
