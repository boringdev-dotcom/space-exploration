import { clamp, damp, Spring1D } from "../util/feel";

/**
 * Smoothed flight input — keyboard + mouse, all routed through critically
 * damped springs (pitch/yaw/roll) and frame-rate-independent damping
 * (throttle). The output is consumed by `FlightScene.setInput` /
 * `MissionScene.setInput` every frame.
 *
 * Channels:
 *  - **Ship steering**: arrow keys drive the ship's pitch/yaw via critically
 *    damped springs. Q/E roll. W/S throttle. Space boost. Snapshot fields:
 *    `pitch`, `yaw`, `roll`, `throttle`, `boost`.
 *  - **Head-look** (independent of ship): mouse delta, when the pointer is
 *    locked, drives `headLookYaw`/`headLookPitch` accumulators with soft
 *    clamps (yaw ±70°, pitch ±40°). The cockpit rig consumes these to rotate
 *    the camera ON TOP of the ship-relative pose, so the player can look
 *    around the cabin without affecting the rocket's heading.
 *
 * Pointer lock: requested via `requestPointerLock()` (host calls on first
 * pointerdown). When unlocked, mouse input is ignored gracefully.
 */
export interface FlightInputSnapshot {
  /** Ship pitch (radians, clamped). */
  pitch: number;
  /** Ship yaw (radians, clamped). */
  yaw: number;
  /** Ship roll (radians, clamped). */
  roll: number;
  /** Throttle 0..2, cruise = 1. */
  throttle: number;
  /** Boost 0..1 (computed each frame from held + fuel). */
  boost: number;
  /** Boost gauge fill 0..1. */
  boostCharge: number;
  /** Whether boost is held this frame. */
  boosting: boolean;
  /** Head-look yaw offset (radians, ±70°). Camera-only, doesn't move ship. */
  headLookYaw: number;
  /** Head-look pitch offset (radians, ±40°). */
  headLookPitch: number;
}

const PITCH_LIMIT = 0.38; // radians, ~22°
const YAW_LIMIT = 0.38;
const ROLL_LIMIT = 0.61; // radians, ~35°
// Wide head-look matches Microsoft Flight Simulator's free-look feel —
// the player can swing the camera around inside the cabin without ship
// heading following along.
const HEAD_YAW_LIMIT = (110 * Math.PI) / 180; // ±110°
const HEAD_PITCH_LIMIT = (60 * Math.PI) / 180; // ±60°
const MOUSE_SENSITIVITY = 0.0011;
const KEY_AXIS_RATE = 0.95; // radians/sec when key is held — clamped by limit

export class FlightInput {
  private element: HTMLElement;

  // Ship-steering springs (driven by arrow keys + Q/E)
  private pitchSpring = new Spring1D(0, 9);
  private yawSpring = new Spring1D(0, 9);
  private rollSpring = new Spring1D(0, 7);

  // Head-look springs (driven by mouse delta only). Slightly stiffer
  // than the ship-steering springs so head pans feel responsive.
  private headLookYawSpring = new Spring1D(0, 14);
  private headLookPitchSpring = new Spring1D(0, 14);
  private headLookEnabled = true;

  private throttle = 1;
  private throttleTarget = 1;

  private boostHeld = false;
  private boostFuel = 1; // 0..1

  // Key state
  private keyW = false;
  private keyS = false;
  private keyQ = false;
  private keyE = false;
  private keyUp = false;
  private keyDown = false;
  private keyLeft = false;
  private keyRight = false;
  private keySpace = false;

  // Pending mouse delta (consumed each frame).
  private pendingMouseX = 0;
  private pendingMouseY = 0;

  private isLocked = false;
  private active = false;
  private bound = false;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  /** Begin reading input. Safe to call every state-enter. */
  start(): void {
    if (this.bound) {
      this.active = true;
      return;
    }
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onLockChange);
    this.element.addEventListener("mousemove", this.onMouseMove);
    this.bound = true;
    this.active = true;
  }

  /** Stop reading input. Lock is released by host. */
  stop(): void {
    this.active = false;
    if (this.bound) {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      document.removeEventListener("pointerlockchange", this.onLockChange);
      this.element.removeEventListener("mousemove", this.onMouseMove);
      this.bound = false;
    }
    this.releaseAll();
  }

  /** Reset to neutral cruise pose. */
  reset(): void {
    this.pitchSpring.reset(0);
    this.yawSpring.reset(0);
    this.rollSpring.reset(0);
    this.headLookYawSpring.reset(0);
    this.headLookPitchSpring.reset(0);
    this.throttle = 1;
    this.throttleTarget = 1;
    this.boostFuel = 1;
    this.boostHeld = false;
    this.releaseAll();
  }

  requestPointerLock(): void {
    if (!this.isLocked) {
      this.element.requestPointerLock?.();
    }
  }

  /**
   * Toggle head-look on/off. Off in chase / external camera modes (where
   * mouse should drive orbit cam instead — handled by the rig).
   */
  setHeadLookEnabled(enabled: boolean): void {
    if (!enabled && this.headLookEnabled) {
      // Drop accumulator targets back to centre when disabling so the next
      // re-enable starts looking forward, not from a stale offset.
      this.headLookYawSpring.target = 0;
      this.headLookPitchSpring.target = 0;
    }
    this.headLookEnabled = enabled;
  }

  /** Drive springs + integrate analog axes from held keys. */
  step(dt: number): FlightInputSnapshot {
    if (!this.active) {
      return this.snapshot();
    }

    // Ship steering — arrow keys + Q/E roll.
    const keyRoll = Number(this.keyE) - Number(this.keyQ);
    const arrowPitch = Number(this.keyDown) - Number(this.keyUp);
    const arrowYaw = Number(this.keyRight) - Number(this.keyLeft);

    const pitchKey = arrowPitch * KEY_AXIS_RATE * dt;
    const yawKey = arrowYaw * KEY_AXIS_RATE * dt;

    this.pitchSpring.target = clamp(
      this.pitchSpring.target + pitchKey,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    this.yawSpring.target = clamp(
      this.yawSpring.target + yawKey,
      -YAW_LIMIT,
      YAW_LIMIT,
    );

    // Auto-recenter when no key is touching the axis.
    if (arrowPitch === 0) {
      this.pitchSpring.target = damp(this.pitchSpring.target, 0, 1.6, dt);
    }
    if (arrowYaw === 0) {
      this.yawSpring.target = damp(this.yawSpring.target, 0, 1.6, dt);
    }

    // Head-look — mouse delta only, independent of ship steering. Mouse Y
    // down → look down → -rotateX (so we negate movementY).
    if (this.headLookEnabled) {
      const expoCurve = (v: number) =>
        Math.sign(v) * Math.pow(Math.abs(v), 1.4);
      const dyaw = expoCurve(this.pendingMouseX * MOUSE_SENSITIVITY);
      const dpitch = expoCurve(this.pendingMouseY * MOUSE_SENSITIVITY);

      this.headLookYawSpring.target = clamp(
        this.headLookYawSpring.target - dyaw,
        -HEAD_YAW_LIMIT,
        HEAD_YAW_LIMIT,
      );
      this.headLookPitchSpring.target = clamp(
        this.headLookPitchSpring.target - dpitch,
        -HEAD_PITCH_LIMIT,
        HEAD_PITCH_LIMIT,
      );
    } else {
      // Smoothly recentre when head-look is disabled (e.g. in chase view).
      this.headLookYawSpring.target = damp(
        this.headLookYawSpring.target,
        0,
        2.5,
        dt,
      );
      this.headLookPitchSpring.target = damp(
        this.headLookPitchSpring.target,
        0,
        2.5,
        dt,
      );
    }
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;

    // Roll holds while keys pressed, eases back to 0 otherwise.
    if (keyRoll === 0) {
      this.rollSpring.target = damp(this.rollSpring.target, 0, 2.2, dt);
    } else {
      this.rollSpring.target = clamp(
        this.rollSpring.target + keyRoll * 1.3 * dt,
        -ROLL_LIMIT,
        ROLL_LIMIT,
      );
    }

    // Throttle. W = increase target; S = decrease. Released = ease back to
    // cruise (1.0). All eased so it never snaps.
    if (this.keyW) this.throttleTarget = Math.min(2, this.throttleTarget + 0.9 * dt);
    if (this.keyS) this.throttleTarget = Math.max(0, this.throttleTarget - 0.9 * dt);
    if (!this.keyW && !this.keyS) {
      this.throttleTarget = damp(this.throttleTarget, 1, 0.6, dt);
    }
    this.throttle = damp(this.throttle, this.throttleTarget, 4.5, dt);

    // Boost: drains while held, recharges when released.
    if (this.keySpace && this.boostFuel > 0) {
      this.boostHeld = true;
      this.boostFuel = Math.max(0, this.boostFuel - dt / 4);
    } else {
      this.boostHeld = false;
      this.boostFuel = Math.min(1, this.boostFuel + dt / 8);
    }
    const boost = this.boostHeld ? Math.min(1, this.boostFuel * 4) : 0;

    // Step every spring.
    this.pitchSpring.step(dt);
    this.yawSpring.step(dt);
    this.rollSpring.step(dt);
    this.headLookYawSpring.step(dt);
    this.headLookPitchSpring.step(dt);

    return this.snapshot(boost);
  }

  private snapshot(boost = 0): FlightInputSnapshot {
    return {
      pitch: this.pitchSpring.value,
      yaw: this.yawSpring.value,
      roll: this.rollSpring.value,
      throttle: this.throttle,
      boost,
      boostCharge: this.boostFuel,
      boosting: this.boostHeld,
      headLookYaw: this.headLookYawSpring.value,
      headLookPitch: this.headLookPitchSpring.value,
    };
  }

  private releaseAll(): void {
    this.keyW = this.keyS = false;
    this.keyQ = this.keyE = false;
    this.keyUp = this.keyDown = this.keyLeft = this.keyRight = false;
    this.keySpace = false;
  }

  private readonly onLockChange = (): void => {
    this.isLocked = document.pointerLockElement === this.element;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.active || !this.isLocked) return;
    this.pendingMouseX += e.movementX;
    this.pendingMouseY += e.movementY;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    switch (e.code) {
      case "KeyW": this.keyW = true; break;
      case "KeyS": this.keyS = true; break;
      case "KeyQ": this.keyQ = true; break;
      case "KeyE": this.keyE = true; break;
      case "ArrowUp": this.keyUp = true; break;
      case "ArrowDown": this.keyDown = true; break;
      case "ArrowLeft": this.keyLeft = true; break;
      case "ArrowRight": this.keyRight = true; break;
      case "Space": this.keySpace = true; e.preventDefault(); break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keyW = false; break;
      case "KeyS": this.keyS = false; break;
      case "KeyQ": this.keyQ = false; break;
      case "KeyE": this.keyE = false; break;
      case "ArrowUp": this.keyUp = false; break;
      case "ArrowDown": this.keyDown = false; break;
      case "ArrowLeft": this.keyLeft = false; break;
      case "ArrowRight": this.keyRight = false; break;
      case "Space": this.keySpace = false; break;
    }
  };
}
