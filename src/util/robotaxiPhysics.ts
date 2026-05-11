import * as THREE from "three";
import type RAPIER_NAMESPACE from "@dimforge/rapier3d-compat";

/**
 * Lazy-init Rapier WASM. Returns the module-level RAPIER namespace so
 * callers can use enums + constructors after this resolves. Cached so
 * multiple summons don't re-load the engine.
 */
let rapierPromise: Promise<typeof RAPIER_NAMESPACE> | null = null;
async function ensureRapier(): Promise<typeof RAPIER_NAMESPACE> {
  if (!rapierPromise) {
    rapierPromise = (async () => {
      const mod = await import("@dimforge/rapier3d-compat");
      await mod.init();
      return mod;
    })();
  }
  return rapierPromise;
}

/**
 * Physics wrapper for the Mars robotaxi. The truck is a dynamic rigid
 * body controlled by Rapier's DynamicRayCastVehicleController, which
 * gives us real suspension, real wheel slip/braking, and proper weight
 * transfer in turns — none of which a spline-snap can fake.
 *
 * The world contains exactly two bodies: the chassis (dynamic) and a
 * wide static ground plane sized to cover the tour area. Splat geometry
 * isn't physicalised — the splat is just a backdrop for the play space,
 * so a flat plane at the splat's ground level is fine here.
 */
export interface RobotaxiPhysics {
  RAPIER: typeof RAPIER_NAMESPACE;
  world: RAPIER_NAMESPACE.World;
  chassis: RAPIER_NAMESPACE.RigidBody;
  vehicle: RAPIER_NAMESPACE.DynamicRayCastVehicleController;

  /** Top engine torque output. Tuned for Mars gravity + cuboid chassis. */
  readonly maxEngineForce: number;
  /** Brake impulse cap. */
  readonly maxBrake: number;
  /** Hard steering lock (radians). */
  readonly maxSteerAngle: number;

  /** RWD: rear wheels only get engine force. */
  setEngineForce(force: number): void;
  /** Braking applied to all four wheels. */
  setBrake(brake: number): void;
  /** Steering applied to the front pair only. */
  setSteering(angle: number): void;

  step(dt: number): void;

  /** Reset to a clean pose (spawn or re-spawn). Zeros velocity. */
  teleport(position: THREE.Vector3, heading: number): void;

  /** Read current chassis position into `out`. Returns `out` for chaining. */
  readPosition(out: THREE.Vector3): THREE.Vector3;
  /** Read current chassis quaternion into `out`. */
  readQuaternion(out: THREE.Quaternion): THREE.Quaternion;
  /** Heading (yaw, radians) consistent with the rest of the surface scene
   *  (0 = -Z, +π/2 = +X). Decomposes the chassis quaternion. */
  heading(): number;
  /** Forward speed (m/s, signed — negative = reversing). */
  forwardSpeed(): number;

  /** Apply a soft horizontal damping so the truck doesn't drift sideways. */
  applyLateralDamping(strength: number, dt: number): void;

  /**
   * Wheel telemetry for visual rigs. Indices match the addWheel order:
   *   0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
   * Front wheels (0, 1) also report a non-zero steering angle.
   */
  readonly wheelCount: number;
  wheelRollAngle(index: number): number;
  /** Last commanded steering (radians). Mirrors {@link setSteering}. */
  currentSteerAngle(): number;
  /** Per-wheel suspension length (m). Useful for visual wheel sag. */
  wheelSuspensionLength(index: number): number;
  /** Wheel rest geometry — model rigs can use this to place their meshes. */
  wheelRadius(index: number): number;

  dispose(): void;
}

export interface RobotaxiPhysicsOptions {
  /** Ground plane Y level. Truck spawns with suspension already near rest. */
  groundY: number;
  /** Ground plane half-extent (square). Cover the tour radius + spawn. */
  groundExtent?: number;
  /** Surface gravity (default Mars: 3.71 m/s²). */
  gravityY?: number;
}

export async function createRobotaxiPhysics(
  options: RobotaxiPhysicsOptions,
): Promise<RobotaxiPhysics> {
  const RAPIER = await ensureRapier();

  const world = new RAPIER.World({
    x: 0,
    y: options.gravityY ?? -3.71,
    z: 0,
  });

  // ---- Ground ---------------------------------------------------------
  // Big thin cuboid centred at the splat scan origin. Friction tuned so
  // tyres bite — too low and the truck will spin out on every corner.
  const groundExtent = options.groundExtent ?? 240;
  const groundDesc = RAPIER.ColliderDesc.cuboid(groundExtent, 0.5, groundExtent)
    .setTranslation(0, options.groundY - 0.5, 0)
    .setFriction(1.15)
    .setRestitution(0.05);
  world.createCollider(groundDesc);

  // ---- Chassis --------------------------------------------------------
  // Cuboid sized to approximate the Cybertruck after model normalisation
  // (ROBOTAXI_TARGET_LENGTH = 4.8 m). Width / height tuned by eye against
  // the actual GLB so the visual mesh wraps the collider cleanly.
  const halfWidth = 1.0;
  const halfHeight = 0.55;
  const halfLength = 2.4;

  // Connection point + rest length + radius gives a stable non-intersecting
  // first pose. The surface scene can still teleport to its calibrated ride
  // height once it knows where the truck should appear.
  const spawnY = options.groundY + 1.38;

  const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, spawnY, 0)
    // Low linear damping lets the truck coast (a real car loses energy
    // through tyre rolling friction + drag, both of which Rapier already
    // models through wheel friction / suspension — extra damping just
    // made everything feel like it was driving through mud).
    .setLinearDamping(0.04)
    // Drop angular damping by 3× so corner roll is visible. With the new
    // engine force + side friction balance the chassis still stays planted;
    // we just don't bolt it to a fictional gimbal anymore.
    .setAngularDamping(0.85)
    .setCcdEnabled(true);
  const chassis = world.createRigidBody(chassisDesc);

  const chassisColliderDesc = RAPIER.ColliderDesc.cuboid(
    halfWidth,
    halfHeight,
    halfLength,
  )
    .setDensity(110)
    .setFriction(0.75)
    .setRestitution(0.05);
  world.createCollider(chassisColliderDesc, chassis);

  // ---- Vehicle --------------------------------------------------------
  const vehicle = world.createVehicleController(chassis);
  vehicle.indexUpAxis = 1; // Y
  vehicle.setIndexForwardAxis = 2; // local +Z

  // Wheel placement. Track ≈ 1.7 m → 0.85 from centre. Wheelbase ≈ 3 m →
  // 1.5 from centre. Vertical offset puts the spring connection roughly at
  // the chassis floor so the suspension extends downward through the
  // collider — the wheel contact point ends up just below ground for a
  // resting "weighted on tires" pose.
  const suspensionRestLength = 0.55;
  const wheelRadius = 0.45;
  const wheelTrack = 0.85;
  const wheelBase = 1.5;
  const wheelConnectionY = -halfHeight + 0.18;

  const wheelLocalPositions: [number, number, number][] = [
    [-wheelTrack, wheelConnectionY, -wheelBase], // FL: visual nose is -Z
    [+wheelTrack, wheelConnectionY, -wheelBase], // FR
    [-wheelTrack, wheelConnectionY, +wheelBase], // RL
    [+wheelTrack, wheelConnectionY, +wheelBase], // RR
  ];

  const directionCs = { x: 0, y: -1, z: 0 }; // suspension shoots straight down
  const axleCs = { x: 1, y: 0, z: 0 }; // wheel axle is the X axis

  wheelLocalPositions.forEach(([x, y, z]) => {
    vehicle.addWheel({ x, y, z }, directionCs, axleCs, suspensionRestLength, wheelRadius);
  });

  // Tune each wheel. Higher stiffness + max suspension force keep the
  // chassis planted at the bumped-up top speed; higher side friction
  // stiffness counteracts the understeer that would otherwise show up
  // once we ditched the heavy angular damping. Friction slip 2.35 gives
  // the tyres real bite so the truck carves instead of pushing wide.
  for (let i = 0; i < 4; i++) {
    vehicle.setWheelSuspensionStiffness(i, 26);
    vehicle.setWheelSuspensionRelaxation(i, 3.2);
    vehicle.setWheelSuspensionCompression(i, 2.4);
    vehicle.setWheelMaxSuspensionTravel(i, 0.42);
    vehicle.setWheelMaxSuspensionForce(i, 9600);
    vehicle.setWheelFrictionSlip(i, 2.35);
    vehicle.setWheelSideFrictionStiffness(i, 1.05);
  }

  // Cached scratch values so per-frame reads don't allocate.
  const _scratchVec = new THREE.Vector3();
  const _scratchQuat = new THREE.Quaternion();
  const _scratchEuler = new THREE.Euler();

  // Engine: ~2.7 m/s² peak accel against the ~1162 kg chassis. Feels
  // brisk-not-launchy and matches a relaxed taxi tour pace once the
  // driver tops out at ROBOTAXI_MAX_SPEED.
  const maxEngineForce = 3200;
  // Brake cap scales with engine force so the truck can actually stop
  // from cruise inside a single curb-approach.
  const maxBrake = 260;
  const maxSteerAngle = 0.42; // ~24°

  // Last commanded steering angle. Rapier exposes a per-wheel getter, but
  // we centralise the value so the visual rig can mirror it without
  // having to bake-in front/rear conventions.
  let lastSteerAngle = 0;
  const WHEEL_COUNT = 4;

  return {
    RAPIER,
    world,
    chassis,
    vehicle,
    maxEngineForce,
    maxBrake,
    maxSteerAngle,

    setEngineForce(force: number) {
      // Rear-wheel drive — more authentic Cybertruck behaviour and
      // gives us oversteer on hard corners instead of the squirrelly
      // 4WD feel that comes from torquing every wheel evenly.
      const clamped = Math.max(-maxEngineForce, Math.min(maxEngineForce, force));
      vehicle.setWheelEngineForce(2, -clamped);
      vehicle.setWheelEngineForce(3, -clamped);
      vehicle.setWheelEngineForce(0, 0);
      vehicle.setWheelEngineForce(1, 0);
    },

    setBrake(brake: number) {
      const b = Math.max(0, Math.min(maxBrake, brake));
      for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, b);
    },

    setSteering(angle: number) {
      const a = Math.max(-maxSteerAngle, Math.min(maxSteerAngle, angle));
      lastSteerAngle = a;
      vehicle.setWheelSteering(0, a);
      vehicle.setWheelSteering(1, a);
      vehicle.setWheelSteering(2, 0);
      vehicle.setWheelSteering(3, 0);
    },

    step(dt: number) {
      // Rapier prefers a fixed timestep, but with the rest of the engine
      // running off a delta we pass dt through. Clamp to avoid huge
      // jumps on tab-resume frames (which would blow up the simulation).
      const stepDt = Math.min(1 / 30, Math.max(1 / 240, dt));
      vehicle.updateVehicle(stepDt);
      world.timestep = stepDt;
      world.step();
    },

    teleport(position: THREE.Vector3, heading: number) {
      // SurfaceScene uses 0 = world -Z, matching the Cybertruck visual nose.
      // Engine force and speed are sign-converted below because Rapier's
      // controller treats local +Z as its forward axis.
      const chassisYaw = heading;
      const half = chassisYaw * 0.5;
      chassis.setTranslation(
        { x: position.x, y: position.y, z: position.z },
        true,
      );
      chassis.setRotation(
        { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
        true,
      );
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },

    readPosition(out: THREE.Vector3) {
      const p = chassis.translation();
      return out.set(p.x, p.y, p.z);
    },

    readQuaternion(out: THREE.Quaternion) {
      const r = chassis.rotation();
      return out.set(r.x, r.y, r.z, r.w);
    },

    heading() {
      const r = chassis.rotation();
      _scratchQuat.set(r.x, r.y, r.z, r.w);
      _scratchEuler.setFromQuaternion(_scratchQuat, "YXZ");
      return _scratchEuler.y;
    },

    forwardSpeed() {
      return -vehicle.currentVehicleSpeed();
    },

    applyLateralDamping(strength: number, dt: number) {
      // Damp small sideways drift without fighting steering. Implemented
      // by reading linear velocity, projecting onto the chassis right
      // axis, and applying an impulse in the opposite direction.
      const linvel = chassis.linvel();
      const r = chassis.rotation();
      _scratchQuat.set(r.x, r.y, r.z, r.w);
      // Right axis in world space = chassis local +X rotated by quat.
      const rightX = 1 - 2 * (r.y * r.y + r.z * r.z);
      const rightZ = 2 * (r.x * r.z - r.w * r.y);
      // Use Y from a full rotation. Skip — we only damp horizontal slip.
      const lateral = linvel.x * rightX + linvel.z * rightZ;
      const impulseMag = -lateral * strength * dt;
      const mass = chassis.mass();
      chassis.applyImpulse(
        {
          x: rightX * impulseMag * mass,
          y: 0,
          z: rightZ * impulseMag * mass,
        },
        true,
      );
      // Reference _scratchVec to keep TS happy about it being used; the
      // damper has no other allocation path.
      void _scratchVec;
    },

    wheelCount: WHEEL_COUNT,

    wheelRollAngle(index: number) {
      const a = vehicle.wheelRotation(index);
      return typeof a === "number" ? a : 0;
    },

    currentSteerAngle() {
      return lastSteerAngle;
    },

    wheelSuspensionLength(index: number) {
      const l = vehicle.wheelSuspensionLength(index);
      return typeof l === "number" ? l : suspensionRestLength;
    },

    wheelRadius(_index: number) {
      // We use a single radius for all wheels so the visual rig can call
      // this once at init time without paying for a Rapier getter.
      return wheelRadius;
    },

    dispose() {
      // Freeing the world drops all bodies, colliders, and the vehicle
      // controller in one shot. Safe to call multiple times.
      world.free();
    },
  };
}
