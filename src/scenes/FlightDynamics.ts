import * as THREE from "three";

/**
 * Arcade Newtonian flight dynamics for the player's spacecraft.
 *
 * The ship has a single transform (position + quaternion) and a velocity
 * vector. Each frame `step(input, dt)` integrates thrust along the ship's
 * forward axis based on throttle/boost, and rotates the ship by the input's
 * pitch/yaw/roll rate command.
 *
 * Scale: 1 world unit = 100 km. Velocity is in units/sec. Multiply by 100 to
 * display as km/s in the HUD.
 *
 * The dynamics are deliberately arcade-style — no real orbital mechanics,
 * no atmospheric drag, just enough physical feel to satisfy "fly the rocket".
 */

export interface ShipState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  /** Forward direction in world space (cached each step). */
  forward: THREE.Vector3;
  /** Up direction in world space (cached each step). */
  up: THREE.Vector3;
}

export interface FlightDynamicsInput {
  /** -1..1 nose-up/down rate command (arrow up/down). */
  pitchRate: number;
  /** -1..1 yaw left/right rate command (arrow left/right). */
  yawRate: number;
  /** -1..1 roll command (Q/E). */
  rollRate: number;
  /** 0..2 throttle. 1 = cruise. */
  throttle: number;
  /** 0..1 boost. */
  boost: number;
}

export interface FlightDynamicsOpts {
  /** Maximum thrust acceleration at full throttle (units/sec^2). */
  maxThrust?: number;
  /** Boost adds this multiplier on top of throttle (1 + boost * boostBonus). */
  boostBonus?: number;
  /** Max angular rate (radians/sec) for pitch/yaw/roll commands. */
  pitchRateMax?: number;
  yawRateMax?: number;
  rollRateMax?: number;
  /** Linear damping factor per second (1 = no damping, 0 = instant stop). */
  dragPerSecond?: number;
  /** Hard cap on translational speed (units/sec). */
  maxSpeed?: number;
}

const DEFAULTS: Required<FlightDynamicsOpts> = {
  // 1 unit = 100 km. Arcade-y, sized so the autopilot can smoothly cover
  // the 5,000-unit destination route in roughly 80–90 seconds while still
  // accelerating to cruise within ~5 seconds.
  maxThrust: 140,
  boostBonus: 1.5,
  pitchRateMax: 0.9,
  yawRateMax: 0.9,
  rollRateMax: 1.4,
  // 0.1% of velocity decays per second so untouched ships eventually stop.
  // Important so a stray input doesn't permanently throw you off course.
  dragPerSecond: 0.001,
  // Cap at 6,000 km/s — paces the trip without dragging.
  maxSpeed: 60,
};

export class FlightDynamics {
  readonly ship: ShipState;
  private readonly opts: Required<FlightDynamicsOpts>;

  /** While true, dynamics step is a no-op (used by liftoff sequence). */
  frozen = false;

  // Reusable scratch vectors so we don't allocate per-frame.
  private readonly _scratchThrust = new THREE.Vector3();
  private readonly _scratchAxis = new THREE.Vector3();
  private readonly _scratchQuat = new THREE.Quaternion();
  private readonly _scratchEuler = new THREE.Euler();

  constructor(initial?: Partial<ShipState>, opts: FlightDynamicsOpts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.ship = {
      position: initial?.position?.clone() ?? new THREE.Vector3(),
      quaternion: initial?.quaternion?.clone() ?? new THREE.Quaternion(),
      velocity: initial?.velocity?.clone() ?? new THREE.Vector3(),
      forward: new THREE.Vector3(0, 0, -1),
      up: new THREE.Vector3(0, 1, 0),
    };
    this.cacheAxes();
  }

  /** Hard-set the ship pose (e.g. for liftoff start, touchdown snap). */
  setPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.ship.position.copy(position);
    this.ship.quaternion.copy(quaternion);
    this.ship.velocity.set(0, 0, 0);
    this.cacheAxes();
  }

  /** Add a velocity impulse in world space (e.g. liftoff thrust pulse). */
  addVelocity(delta: THREE.Vector3): void {
    this.ship.velocity.add(delta);
  }

  step(input: FlightDynamicsInput, dt: number): void {
    if (this.frozen || dt <= 0) {
      this.cacheAxes();
      return;
    }

    // Attitude — apply angular rate command around ship-local axes so pitch
    // is always "nose up/down relative to the ship", regardless of world
    // orientation. This avoids gimbal-lock weirdness during inverted flight.
    const pitchDelta = input.pitchRate * this.opts.pitchRateMax * dt;
    const yawDelta = -input.yawRate * this.opts.yawRateMax * dt;
    const rollDelta = -input.rollRate * this.opts.rollRateMax * dt;

    if (pitchDelta !== 0 || yawDelta !== 0 || rollDelta !== 0) {
      this._scratchEuler.set(pitchDelta, yawDelta, rollDelta, "XYZ");
      this._scratchQuat.setFromEuler(this._scratchEuler);
      this.ship.quaternion.multiply(this._scratchQuat);
      this.ship.quaternion.normalize();
    }

    this.cacheAxes();

    // Thrust along the ship's forward axis. Throttle 0..2, boost 0..1.
    const thrustAccel =
      this.opts.maxThrust *
      Math.max(0, input.throttle) *
      (1 + input.boost * this.opts.boostBonus);

    if (thrustAccel > 0) {
      this._scratchThrust.copy(this.ship.forward).multiplyScalar(thrustAccel * dt);
      this.ship.velocity.add(this._scratchThrust);
    }

    // Linear damping (frame-rate-independent).
    const dragMul = Math.pow(1 - this.opts.dragPerSecond, dt * 60); // approx
    this.ship.velocity.multiplyScalar(dragMul);

    // Speed cap.
    const speed = this.ship.velocity.length();
    if (speed > this.opts.maxSpeed) {
      this.ship.velocity.multiplyScalar(this.opts.maxSpeed / speed);
    }

    // Integrate position.
    this._scratchThrust.copy(this.ship.velocity).multiplyScalar(dt);
    this.ship.position.add(this._scratchThrust);
  }

  /** Speed in km/s (scale: 1 unit = 100 km, so velocity * 100). */
  speedKmS(): number {
    return this.ship.velocity.length() * 100;
  }

  /** Refresh the cached forward + up vectors after pose changes. */
  private cacheAxes(): void {
    this.ship.forward
      .set(0, 0, -1)
      .applyQuaternion(this.ship.quaternion);
    this.ship.up
      .set(0, 1, 0)
      .applyQuaternion(this.ship.quaternion);
    // Suppress unused warning for axis scratch.
    void this._scratchAxis;
  }
}
