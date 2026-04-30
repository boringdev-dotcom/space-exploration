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
  /** Held: brake — damps velocity to zero. */
  brake: boolean;
  /** Held: retrograde-hold — slerp ship attitude toward -velocity. */
  retrograde: boolean;
  /** Held: prograde-hold — slerp ship attitude toward +velocity. */
  prograde: boolean;
  /** Held: level horizon — zero roll, hold horizontal pitch. */
  level: boolean;
  /** Held: look-back — flicks head-look 180° behind. */
  lookBack: boolean;
}

/** Edge-triggered callbacks emitted alongside the per-frame snapshot. */
export interface FlightInputEvents {
  /** First time the player touches a steering key in the session. */
  onAnyDeliberateInput?: () => void;
  /** Tab keydown — caller toggles autopilot. */
  onAutopilotToggle?: () => void;
  /** F keydown — caller toggles free-fly. */
  onFreeFlyToggle?: () => void;
  /** 1/2/3 keydown — caller sets view directly. */
  onSetView?: (mode: "cockpit" | "chase" | "external") => void;
  /** H keydown — caller toggles help overlay. */
  onToggleHelp?: () => void;
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

  /**
   * Current camera view mode. Drives per-mode head-look behaviour:
   *   - cockpit: tight ±110° / ±60° limits; releases drift slowly back to
   *     forward so the pilot's head naturally relaxes.
   *   - chase / external: wide ±180° / ±80° limits; releases HOLD position
   *     so the player can drag-set an angle and have the camera stay
   *     there (MSFS / orbital-cam feel).
   */
  private viewMode: "cockpit" | "chase" | "external" = "cockpit";

  private throttle = 1;
  private throttleTarget = 1;

  private boostHeld = false;
  private boostFuel = 1; // 0..1

  // Key state — analog (held).
  private keyW = false;
  private keyS = false;
  private keyQ = false;
  private keyE = false;
  // A/D mirror Q/E for roll — MSFS-style "roll on home row" works for
  // anyone who's never touched a flight sim before.
  private keyA = false;
  private keyD = false;
  private keyUp = false;
  private keyDown = false;
  private keyLeft = false;
  private keyRight = false;
  private keySpace = false;
  private keyB = false; // brake
  private keyR = false; // retrograde
  private keyT = false; // prograde
  private keyZ = false; // level horizon
  private keyV = false; // look-back

  // Edge-triggered events the host wires into.
  private inputEvents: FlightInputEvents = {};
  /** Set true once any deliberate steering input has been observed. */
  private deliberateFired = false;

  /** Mouse sensitivity multiplier (settable for future settings panel). */
  private mouseSensScale = 1;

  // Pending mouse delta (consumed each frame).
  private pendingMouseX = 0;
  private pendingMouseY = 0;

  /** True while the player is dragging the mouse to look around. */
  private isDragging = false;
  /** Last mouse client coords (used to compute dragging deltas). */
  private lastMouseX = 0;
  private lastMouseY = 0;

  private active = false;
  private bound = false;

  /** Subscribers notified whenever drag state flips. */
  private lockListeners: Array<(locked: boolean) => void> = [];

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
    // Click-and-drag camera control: mousedown on the canvas starts a
    // drag session, mousemove (anywhere on window while dragging)
    // accumulates delta, mouseup/leave ends the drag. This replaces
    // pointer-lock mouse-look — no more accidental trackpad swipes.
    this.element.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("blur", this.onBlur);
    // Touch support: mirror the mouse drag with single-finger touches.
    this.element.addEventListener("touchstart", this.onTouchStart, { passive: true });
    window.addEventListener("touchmove", this.onTouchMove, { passive: true });
    window.addEventListener("touchend", this.onTouchEnd);
    this.bound = true;
    this.active = true;
  }

  /** Stop reading input. */
  stop(): void {
    this.active = false;
    if (this.bound) {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      this.element.removeEventListener("mousedown", this.onMouseDown);
      window.removeEventListener("mousemove", this.onMouseMove);
      window.removeEventListener("mouseup", this.onMouseUp);
      window.removeEventListener("blur", this.onBlur);
      this.element.removeEventListener("touchstart", this.onTouchStart);
      window.removeEventListener("touchmove", this.onTouchMove);
      window.removeEventListener("touchend", this.onTouchEnd);
      this.bound = false;
    }
    this.endDrag();
    this.releaseAll();
  }

  /** Reset to engines-off pose at the launch pad. */
  reset(): void {
    this.pitchSpring.reset(0);
    this.yawSpring.reset(0);
    this.rollSpring.reset(0);
    this.headLookYawSpring.reset(0);
    this.headLookPitchSpring.reset(0);
    this.throttle = 0;
    this.throttleTarget = 0;
    this.boostFuel = 1;
    this.boostHeld = false;
    this.deliberateFired = false;
    this.releaseAll();
  }

  /** Wire edge-triggered callbacks (autopilot toggle, view set, help, etc.). */
  setEvents(events: FlightInputEvents): void {
    this.inputEvents = events;
  }

  /** Multiplier on mouse sensitivity. 1 = default. */
  setMouseSensitivity(scale: number): void {
    this.mouseSensScale = Math.max(0.1, Math.min(4, scale));
  }

  /**
   * Legacy hook retained so existing call sites (e.g. flightHud's
   * click-to-engage flow) compile. Click-and-drag mouse-look does not
   * require pointer lock, so this is a no-op.
   */
  requestPointerLock(): void {
    /* no-op — replaced by click-and-drag */
  }

  /**
   * Update the current camera view mode. The host (SceneManager) calls
   * this whenever the player toggles or sets the view directly.
   *
   * Side-effect: when transitioning INTO cockpit, snap the head-look
   * accumulators to 0 so the pilot starts looking forward through the
   * windshield. Toggling between chase / external preserves the orbit
   * angle the player set so the camera feels persistent.
   */
  setViewMode(mode: "cockpit" | "chase" | "external"): void {
    if (mode === this.viewMode) return;
    if (mode === "cockpit" && this.viewMode !== "cockpit") {
      this.headLookYawSpring.target = 0;
      this.headLookPitchSpring.target = 0;
    }
    this.viewMode = mode;
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

    // Ship steering — arrow keys + Q/E or A/D for roll.
    const keyRoll =
      Number(this.keyE) -
      Number(this.keyQ) +
      Number(this.keyD) -
      Number(this.keyA);
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
    if (this.keyV) {
      // Look-back: snap targets to 180° behind. The springs swing
      // smoothly without us touching `value` directly.
      this.headLookYawSpring.target = damp(
        this.headLookYawSpring.target,
        Math.PI,
        9,
        dt,
      );
      this.headLookPitchSpring.target = damp(
        this.headLookPitchSpring.target,
        0,
        9,
        dt,
      );
    } else if (this.headLookEnabled && this.isDragging) {
      // Click-and-drag: only consume mouse delta while the player is
      // actively dragging. Trackpad-swipe annoyance gone.
      const expoCurve = (v: number) =>
        Math.sign(v) * Math.pow(Math.abs(v), 1.2);
      // Chase / external: a single wrist drag should swing the orbit
      // camera meaningfully — bump sensitivity 1.4×.
      const sensMul = this.viewMode === "cockpit" ? 1.0 : 1.4;
      const sens = MOUSE_SENSITIVITY * this.mouseSensScale * sensMul;
      const dyaw = expoCurve(this.pendingMouseX * sens);
      const dpitch = expoCurve(this.pendingMouseY * sens);

      // Per-mode head-look limits. Cockpit mimics a real pilot's head;
      // chase / external orbit cleanly through the full sphere.
      const yawLimit =
        this.viewMode === "cockpit" ? HEAD_YAW_LIMIT : Math.PI;
      const pitchLimit =
        this.viewMode === "cockpit"
          ? HEAD_PITCH_LIMIT
          : (80 * Math.PI) / 180;

      this.headLookYawSpring.target = clamp(
        this.headLookYawSpring.target - dyaw,
        -yawLimit,
        yawLimit,
      );
      this.headLookPitchSpring.target = clamp(
        this.headLookPitchSpring.target - dpitch,
        -pitchLimit,
        pitchLimit,
      );
    } else {
      // Mouse not held. Per-mode release behaviour:
      //   cockpit: slow drift back to centre — pilot's head naturally
      //            relaxes forward over a couple of seconds.
      //   chase / external: HOLD position. The MSFS rule — once you've
      //            framed the shot with a drag, the camera stays there
      //            until you drag again or cycle the view.
      if (this.viewMode === "cockpit") {
        this.headLookYawSpring.target = damp(
          this.headLookYawSpring.target,
          0,
          1.5,
          dt,
        );
        this.headLookPitchSpring.target = damp(
          this.headLookPitchSpring.target,
          0,
          1.5,
          dt,
        );
      }
      // chase / external: no recentre — orbit angle persists.
    }
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;

    // Roll holds while keys pressed, eases back to 0 otherwise. Rate
    // is faster than pitch/yaw so banking turns feel snappy (matches
    // MSFS roll authority).
    if (keyRoll === 0) {
      this.rollSpring.target = damp(this.rollSpring.target, 0, 2.5, dt);
    } else {
      this.rollSpring.target = clamp(
        this.rollSpring.target + keyRoll * 3.5 * dt,
        -ROLL_LIMIT,
        ROLL_LIMIT,
      );
    }


    // Throttle. W = increase, S = decrease. The throttle HOLDS where you
    // set it — no auto-recenter. This matches real aircraft / MSFS
    // behaviour: the player parks the rocket on the pad with throttle 0
    // and ramps it up themselves to lift off.
    if (this.keyW) this.throttleTarget = Math.min(2, this.throttleTarget + 1.1 * dt);
    if (this.keyS) this.throttleTarget = Math.max(0, this.throttleTarget - 1.1 * dt);
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
      brake: this.keyB,
      retrograde: this.keyR,
      prograde: this.keyT,
      level: this.keyZ,
      lookBack: this.keyV,
    };
  }


  private releaseAll(): void {
    this.keyW = this.keyS = false;
    this.keyQ = this.keyE = false;
    this.keyA = this.keyD = false;
    this.keyUp = this.keyDown = this.keyLeft = this.keyRight = false;
    this.keySpace = false;
    this.keyB = this.keyR = this.keyT = this.keyZ = this.keyV = false;
  }

  /**
   * Emit `onAnyDeliberateInput` exactly once per session the first time the
   * player taps a flight key. Used by SceneManager to flip auto → manual.
   */
  private fireDeliberate(): void {
    if (this.deliberateFired) return;
    this.deliberateFired = true;
    this.inputEvents.onAnyDeliberateInput?.();
  }

  /**
   * Subscribe to drag-state changes. Reuses the pointer-lock listener
   * API so the HUD's "click to engage" overlay can show/hide based on
   * whether the player is currently dragging the camera.
   */
  onPointerLockChange(cb: (locked: boolean) => void): () => void {
    this.lockListeners.push(cb);
    return () => {
      this.lockListeners = this.lockListeners.filter((x) => x !== cb);
    };
  }

  /** Whether the player is currently click-dragging the camera. */
  get pointerLocked(): boolean {
    return this.isDragging;
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    // Left button only; ignore clicks on the HUD chrome (handled by
    // their own listeners — those events bubble up to window where we
    // also catch mousemove/mouseup).
    if (!this.active || e.button !== 0) return;
    if (e.target instanceof HTMLButtonElement) return;
    if (e.target instanceof HTMLAnchorElement) return;
    this.beginDrag(e.clientX, e.clientY);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.active || !this.isDragging) return;
    this.pendingMouseX += e.clientX - this.lastMouseX;
    this.pendingMouseY += e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
  };

  private readonly onMouseUp = (): void => {
    this.endDrag();
  };

  private readonly onBlur = (): void => {
    this.endDrag();
  };

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (!this.active) return;
    const t = e.touches[0];
    if (!t) return;
    if (t.target instanceof HTMLButtonElement) return;
    this.beginDrag(t.clientX, t.clientY);
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (!this.active || !this.isDragging) return;
    const t = e.touches[0];
    if (!t) return;
    this.pendingMouseX += t.clientX - this.lastMouseX;
    this.pendingMouseY += t.clientY - this.lastMouseY;
    this.lastMouseX = t.clientX;
    this.lastMouseY = t.clientY;
  };

  private readonly onTouchEnd = (): void => {
    this.endDrag();
  };

  private beginDrag(x: number, y: number): void {
    if (this.isDragging) return;
    this.isDragging = true;
    this.lastMouseX = x;
    this.lastMouseY = y;
    this.element.classList.add("is-dragging");
    this.lockListeners.forEach((cb) => cb(true));
  }

  private endDrag(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    this.element.classList.remove("is-dragging");
    this.lockListeners.forEach((cb) => cb(false));
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.repeat) {
      // Held: continue normal analog handling, no edge fire.
      return;
    }
    switch (e.code) {
      case "KeyW": this.keyW = true; this.fireDeliberate(); break;
      case "KeyS": this.keyS = true; this.fireDeliberate(); break;
      case "KeyQ": this.keyQ = true; this.fireDeliberate(); break;
      case "KeyE": this.keyE = true; this.fireDeliberate(); break;
      case "KeyA": this.keyA = true; this.fireDeliberate(); break;
      case "KeyD": this.keyD = true; this.fireDeliberate(); break;
      case "ArrowUp": this.keyUp = true; this.fireDeliberate(); break;
      case "ArrowDown": this.keyDown = true; this.fireDeliberate(); break;
      case "ArrowLeft": this.keyLeft = true; this.fireDeliberate(); break;
      case "ArrowRight": this.keyRight = true; this.fireDeliberate(); break;
      case "Space":
        this.keySpace = true;
        this.fireDeliberate();
        e.preventDefault();
        break;
      case "KeyB": this.keyB = true; this.fireDeliberate(); break;
      case "KeyR": this.keyR = true; this.fireDeliberate(); break;
      case "KeyT": this.keyT = true; this.fireDeliberate(); break;
      case "KeyZ": this.keyZ = true; this.fireDeliberate(); break;
      case "KeyV": this.keyV = true; break;
      // Edge-only events.
      case "Tab":
        e.preventDefault();
        this.inputEvents.onAutopilotToggle?.();
        break;
      case "KeyF":
        this.inputEvents.onFreeFlyToggle?.();
        break;
      case "KeyH":
        this.inputEvents.onToggleHelp?.();
        break;
      case "Digit1":
        this.inputEvents.onSetView?.("cockpit");
        break;
      case "Digit2":
        this.inputEvents.onSetView?.("chase");
        break;
      case "Digit3":
        this.inputEvents.onSetView?.("external");
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keyW = false; break;
      case "KeyS": this.keyS = false; break;
      case "KeyQ": this.keyQ = false; break;
      case "KeyE": this.keyE = false; break;
      case "KeyA": this.keyA = false; break;
      case "KeyD": this.keyD = false; break;
      case "ArrowUp": this.keyUp = false; break;
      case "ArrowDown": this.keyDown = false; break;
      case "ArrowLeft": this.keyLeft = false; break;
      case "ArrowRight": this.keyRight = false; break;
      case "Space": this.keySpace = false; break;
      case "KeyB": this.keyB = false; break;
      case "KeyR": this.keyR = false; break;
      case "KeyT": this.keyT = false; break;
      case "KeyZ": this.keyZ = false; break;
      case "KeyV": this.keyV = false; break;
    }
  };
}
