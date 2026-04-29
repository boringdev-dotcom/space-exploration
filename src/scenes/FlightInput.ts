import { clamp, damp, Spring1D } from "../util/feel";

/**
 * Smoothed flight input — keyboard + mouse, all routed through critically
 * damped springs (pitch/yaw/roll) and frame-rate-independent damping
 * (throttle). The output is consumed by `FlightScene.setInput` every frame.
 *
 * Inputs:
 *  - Mouse delta (when pointer is locked) → yaw/pitch deltas with deadzone
 *    and exponential acceleration curve so micro-corrections feel surgical.
 *  - Arrow keys / WASD → analog accumulators that feel like a joystick.
 *  - Q / E → roll.
 *  - W / S → throttle up / down. Released keys ease back toward 1.0 (cruise).
 *  - Space → boost; charges over time, drains while held.
 *
 * Pointer lock: requested via `requestPointerLock()` (host calls on first
 * pointerdown). When unlocked, mouse input is ignored gracefully.
 */
export interface FlightInputSnapshot {
  pitch: number; // radians, clamped ±0.38 (~22°)
  yaw: number;
  roll: number; // radians, clamped ±0.61 (~35°)
  throttle: number; // 0..2, cruise = 1
  boost: number; // 0..1
  boostCharge: number; // 0..1, gauge fill
  boosting: boolean;
}

const PITCH_LIMIT = 0.38; // radians, ~22°
const YAW_LIMIT = 0.38;
const ROLL_LIMIT = 0.61; // radians, ~35°
const MOUSE_SENSITIVITY = 0.0014;
const KEY_AXIS_RATE = 0.95; // radians/sec when key is held — clamped by limit

export class FlightInput {
  private element: HTMLElement;

  private pitchSpring = new Spring1D(0, 9);
  private yawSpring = new Spring1D(0, 9);
  private rollSpring = new Spring1D(0, 7);

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
  private pendingPitch = 0;
  private pendingYaw = 0;

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

  /** Stop reading input. Lock is released by host (FlightScene exit). */
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

  /** Drive springs + integrate analog axes from held keys. */
  step(dt: number): FlightInputSnapshot {
    if (!this.active) {
      return this.snapshot();
    }

    // W/S is overloaded — when used for throttle (preferred), arrow keys
    // handle pitch/yaw to avoid conflict. A/D currently aren't used (we
    // could repurpose them for strafe later if free flight lands).
    const keyRoll = Number(this.keyE) - Number(this.keyQ);
    const arrowPitch = Number(this.keyDown) - Number(this.keyUp);
    const arrowYaw = Number(this.keyRight) - Number(this.keyLeft);

    // Build target offsets. Mouse pendings are exponential (more sensitive
    // for small motions, faster for big ones).
    const expoCurve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.4);
    const pitchKey = arrowPitch * KEY_AXIS_RATE * dt;
    const yawKey = arrowYaw * KEY_AXIS_RATE * dt;
    const pitchMouse = expoCurve(this.pendingPitch * MOUSE_SENSITIVITY);
    const yawMouse = expoCurve(this.pendingYaw * MOUSE_SENSITIVITY);

    this.pitchSpring.target = clamp(
      this.pitchSpring.target + pitchKey + pitchMouse,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    this.yawSpring.target = clamp(
      this.yawSpring.target + yawKey + yawMouse,
      -YAW_LIMIT,
      YAW_LIMIT,
    );

    // Auto-recenter when no input is touching the axis. Critical for "feels
    // grounded" — without it the camera drifts forever after a small flick.
    if (arrowPitch === 0 && Math.abs(this.pendingPitch) < 0.01) {
      this.pitchSpring.target = damp(this.pitchSpring.target, 0, 1.6, dt);
    }
    if (arrowYaw === 0 && Math.abs(this.pendingYaw) < 0.01) {
      this.yawSpring.target = damp(this.yawSpring.target, 0, 1.6, dt);
    }
    this.pendingPitch = 0;
    this.pendingYaw = 0;

    // Roll: holds while keys are pressed, eases back to 0 otherwise (slower
    // than pitch/yaw because it's more visible).
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

    // Boost. Drains fuel while held, recharges when released. Visual + audio
    // bias (set on the post fx + drone elsewhere) ride on top of `boost`.
    if (this.keySpace && this.boostFuel > 0) {
      this.boostHeld = true;
      this.boostFuel = Math.max(0, this.boostFuel - dt / 4);
    } else {
      this.boostHeld = false;
      this.boostFuel = Math.min(1, this.boostFuel + dt / 8);
    }
    const boost = this.boostHeld ? Math.min(1, this.boostFuel * 4) : 0;

    // Step the springs.
    this.pitchSpring.step(dt);
    this.yawSpring.step(dt);
    this.rollSpring.step(dt);

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
    // Mouse Y down → look down → +pitch in screen space → -rotateX in three.
    this.pendingPitch += e.movementY;
    this.pendingYaw += e.movementX;
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
