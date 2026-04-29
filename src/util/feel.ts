import * as THREE from "three";

/**
 * Shared "feel" helpers — easings + frame-rate-independent damping + critically
 * damped spring. Every motion in the app should route through these so we never
 * have hard cuts or untweened state flips. See the project plan for the
 * "aesthetics first" north-star.
 */

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);

export const easeInOutSine = (t: number): number =>
  -(Math.cos(Math.PI * t) - 1) / 2;

/** Smoothstep used to keep a value in [0,1] with no zipper artifacts. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const clamp = (x: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, x));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Frame-rate-independent damping: at every dt, blend `current` toward `target`
 * with a half-life implied by `lambda` (1/seconds). Higher lambda = faster.
 * `damp(a, b, 8, dt)` settles in roughly 250–400ms.
 *
 * This is the form to use everywhere; never `lerp(a, b, 0.1)` directly inside
 * a per-frame update.
 */
export const damp = (
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number => current + (target - current) * (1 - Math.exp(-lambda * dt));

/** Vector3 variant of {@link damp}. Mutates and returns `out`. */
export function dampVec3(
  out: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number,
): THREE.Vector3 {
  const k = 1 - Math.exp(-lambda * dt);
  out.x += (target.x - out.x) * k;
  out.y += (target.y - out.y) * k;
  out.z += (target.z - out.z) * k;
  return out;
}

/** Damp an angle in radians — handles wrap-around so we don't tween the long way. */
export function dampAngle(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

/**
 * Critically-damped spring (no overshoot). Useful for input → camera coupling
 * where you want a natural "give" without oscillation.
 *
 *   const yaw = new Spring1D(0, 8); // 8 Hz
 *   yaw.target = mouseDeltaYaw;
 *   yaw.step(dt);
 *   camera.rotation.y += yaw.value;
 */
export class Spring1D {
  value: number;
  velocity = 0;
  target: number;
  /** Angular frequency (radians/sec). Higher = stiffer / settles faster. */
  omega: number;

  constructor(initial = 0, omega = 8) {
    this.value = initial;
    this.target = initial;
    this.omega = omega;
  }

  reset(value = 0): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  step(dt: number): number {
    if (dt <= 0) return this.value;
    // Critically damped: zeta = 1, so damping = 2 * omega.
    const w = this.omega;
    const x = this.value - this.target;
    // Implicit Euler integration — stable at any dt.
    const denom = 1 + 2 * w * dt + w * w * dt * dt;
    const newVelocity = (this.velocity - w * w * dt * x) / denom;
    const newValue = this.value + newVelocity * dt;
    this.velocity = newVelocity;
    this.value = newValue;
    return this.value;
  }
}

/**
 * Tiny tween manager. Schedule a 0→1 ramp over `durationSec`, optionally with
 * an easing function. Returns a cancel handle. Use for one-shot choreographed
 * moves like the view-mode dolly.
 */
export class Tween {
  private t = 0;
  private active = false;
  private duration: number;
  private easing: (t: number) => number;
  private onUpdate: (eased: number, raw: number) => void;
  private onDone?: () => void;

  constructor(
    durationSec: number,
    easing: (t: number) => number,
    onUpdate: (eased: number, raw: number) => void,
    onDone?: () => void,
  ) {
    this.duration = Math.max(0.0001, durationSec);
    this.easing = easing;
    this.onUpdate = onUpdate;
    this.onDone = onDone;
  }

  start(): void {
    this.t = 0;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Drive from a per-frame loop. */
  update(dt: number): void {
    if (!this.active) return;
    this.t = Math.min(this.duration, this.t + dt);
    const raw = this.t / this.duration;
    this.onUpdate(this.easing(raw), raw);
    if (raw >= 1) {
      this.active = false;
      this.onDone?.();
    }
  }
}

/**
 * Cheap deterministic 1-D pseudo-noise: smooth sin combo, no allocations. For
 * idle hand-held camera sway and breathing animations where Perlin would be
 * overkill.
 */
export function noise1D(t: number, seed = 0): number {
  return (
    (Math.sin(t * 1.13 + seed * 1.7) +
      Math.sin(t * 2.71 + seed * 4.3) * 0.5 +
      Math.sin(t * 0.41 + seed * 9.7) * 0.25) /
    1.75
  );
}
