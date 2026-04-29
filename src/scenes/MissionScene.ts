import * as THREE from "three";
import { SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import { CockpitRig, type ViewMode } from "./CockpitRig";
import {
  FlightDynamics,
  type FlightDynamicsInput,
  type ShipState,
} from "./FlightDynamics";
import {
  PhaseController,
  type MissionPhase,
  type PhaseFeel,
} from "./PhaseController";
import {
  createEarth,
  EARTH_RADIUS,
  type Earth,
} from "./Earth";
import { createStarfield } from "../util/starfield";
import { COCKPITS } from "../data/cockpits";
import type { Planet } from "../data/planets";
import {
  damp,
  dampVec3,
  easeOutCubic,
  noise1D,
  smoothstep,
  Tween,
} from "../util/feel";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";

/**
 * Continuous mission scene — one playable flight from Earth pad through
 * touchdown on the destination, replacing the cinematic flight + arrival +
 * surface-deploy chain.
 *
 * World scale: 1 unit = 100 km. Earth at origin, destination at -Z 5000.
 * Far plane 12000 keeps the whole frame in single-precision range without
 * floating-origin trickery.
 */

const WORLD_SCALE_KM_PER_UNIT = 100;
const DESTINATION_DISTANCE = 5000; // units along -Z
const DESTINATION_RADIUS = 18; // units; planet GLBs rescaled to this diameter * 2
// Launch is from a "low orbital" altitude so the chase / external camera has
// room to frame Earth + rocket without the camera clipping through Earth.
// 4 units = 400 km, roughly the ISS orbital altitude — plausibly "ready to
// burn for the destination" rather than pre-liftoff sea level.
const SHIP_PAD_OFFSET = 4;
const APPROACH_RANGE = 200; // distance to dest centre that flips to "approach"
const TOUCHDOWN_RANGE = 8; // altitude above dest surface that flips to "touchdown"

/** Ship-local forward axis (CockpitRig convention: -Z is forward). */
const _shipForwardLocal = new THREE.Vector3(0, 0, -1);

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export interface MissionInput extends FlightDynamicsInput {
  /** Head-look yaw (radians) — passed straight to CockpitRig in cockpit mode. */
  headLookYaw: number;
  /** Head-look pitch (radians). */
  headLookPitch: number;
}

export interface MissionTelemetry {
  phase: MissionPhase;
  speedKmS: number;
  /** Altitude above origin Earth's surface (km). Negative once on ground. */
  altitudeKm: number;
  /** Distance to the destination centre (km). */
  rangeKm: number;
  /** Altitude above the destination surface (km). */
  destinationAltitudeKm: number;
  /** Pitch / roll of the ship in degrees (for the attitude indicator). */
  shipPitchDeg: number;
  shipRollDeg: number;
  shipYawDeg: number;
}

export interface MissionEvents {
  onPhaseChange?: (next: MissionPhase, prev: MissionPhase) => void;
  /** Fired once when the ship has fully touched down and walking should begin. */
  onTouchdown?: (info: { spawnPose: { position: THREE.Vector3; quaternion: THREE.Quaternion } }) => void;
}

export class MissionScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  readonly rig: CockpitRig;
  readonly dynamics: FlightDynamics;
  readonly phaseController: PhaseController;

  private readonly spark: SparkRenderer | null;
  private earth: Earth;
  private starfield: THREE.Points;
  private sun: THREE.DirectionalLight;

  private destinationGroup = new THREE.Group();
  private destinationMesh: THREE.Mesh;
  private destinationModel: THREE.Group | null = null;
  private destinationModelLoadId = 0;
  private surfaceSplat: SplatMesh | null = null;
  private surfaceSplatLoadId = 0;
  private surfaceSplatGroup = new THREE.Group();
  private surfaceFade = 0; // 0..1 alpha multiplier

  private currentPlanet: Planet | null = null;
  private events: MissionEvents = {};

  private input: MissionInput = {
    pitchRate: 0,
    yawRate: 0,
    rollRate: 0,
    throttle: 0,
    boost: 0,
    headLookYaw: 0,
    headLookPitch: 0,
  };

  private liftoffElapsed = 0;
  private readonly LIFTOFF_DURATION = 6;

  /** Latest autopilot throttle value (0..2) — used for plume + shake feel. */
  private autopilotThrottle = 0;
  /** Reusable scratch for the desired-forward direction. */
  private readonly _scratchDesiredFwd = new THREE.Vector3();
  private readonly _scratchDesiredQuat = new THREE.Quaternion();

  /** True after the player has fired the engines for the first time. */
  ignited = false;

  /**
   * Opening cinematic stage:
   *   exterior_intro      — 1.5s framing of the rocket on the pad
   *   ascending_external  — external camera trails the climbing rocket
   *   blend_to_cockpit    — 1.4s crossfade external → cockpit, splat fades in
   *   cockpit             — handed off to autopilot + head-look
   */
  private openingStage:
    | "exterior_intro"
    | "ascending_external"
    | "blend_to_cockpit"
    | "cockpit" = "cockpit";
  private openingElapsed = 0;
  private static readonly EXTERIOR_INTRO_SEC = 1.5;
  private static readonly COCKPIT_FADE_SEC = 1.4;

  /** Touchdown handoff tween — camera detaches from ship for 1.2s before walking. */
  private touchdownTween: Tween | null = null;
  private touchdownFiredHandoff = false;

  // Reusable scratch.
  private readonly _scratchVec = new THREE.Vector3();
  private readonly _scratchShake = new THREE.Vector3();
  private readonly _scratchRadial = new THREE.Vector3();
  private readonly _scratchEuler = new THREE.Euler();

  constructor(spark?: SparkRenderer) {
    this.spark = spark ?? null;

    this.camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.1,
      12000,
    );
    // Start near Earth so the first frame doesn't show black void.
    this.camera.position.set(0, EARTH_RADIUS + 6, 0);
    this.scene.add(this.camera);

    // Lighting — single warm sun + faint cool ambient so the night side of
    // Earth + the destination still reads.
    this.sun = new THREE.DirectionalLight(0xfff1d6, 3.4);
    this.sun.position.set(800, 320, -400);
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x39496a, 0.35));

    // Earth (GLB body + procedural shells).
    this.earth = createEarth();
    this.earth.setSunDirection(this.sun.position.clone().normalize());
    this.scene.add(this.earth.group);

    // Distant starfield. Static at the far horizon; rotates very slowly.
    this.starfield = createStarfield({
      count: 8000,
      radius: 9500,
      size: 4.5,
    });
    this.scene.add(this.starfield);

    // Destination placeholder sphere — a neutral grey ball that gets
    // recoloured + replaced by the planet GLB when we enter approach phase.
    const destGeom = new THREE.SphereGeometry(DESTINATION_RADIUS, 64, 64);
    const destMat = new THREE.MeshStandardMaterial({
      color: 0x9b9b9b,
      roughness: 0.85,
      metalness: 0.05,
      emissive: 0x111111,
      emissiveIntensity: 0.25,
    });
    this.destinationMesh = new THREE.Mesh(destGeom, destMat);
    this.destinationMesh.position.set(0, 0, -DESTINATION_DISTANCE);
    this.destinationGroup.add(this.destinationMesh);
    this.destinationGroup.add(this.surfaceSplatGroup);
    this.surfaceSplatGroup.position.copy(this.destinationMesh.position);
    this.scene.add(this.destinationGroup);

    // Cockpit rig + the ship transform feeding it.
    this.rig = new CockpitRig({ scene: this.scene, camera: this.camera });
    this.dynamics = new FlightDynamics(
      {
        position: new THREE.Vector3(0, EARTH_RADIUS + SHIP_PAD_OFFSET, 0),
        // Nose pointing up (+Y) at takeoff. Pre-rotate so the ship's local
        // -Z (CockpitRig + Artemis GLB convention for "forward") aligns
        // with world +Y at start. Easiest construction: lookAt-style
        // quaternion that maps -Z to +Y.
        quaternion: new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0, 1, 0),
        ),
      },
      {
        // Slightly punchier than defaults — short-trip arcade feel.
        maxThrust: 95,
        boostBonus: 1.6,
      },
    );

    // Hand the dynamics ship to the rig so the rig follows it.
    this.rig.followShip(this.dynamics.ship);

    // Phase controller wires Earth + destination into the state machine.
    this.phaseController = new PhaseController(
      {
        earthCenter: new THREE.Vector3(0, 0, 0),
        earthRadius: EARTH_RADIUS,
        destinationCenter: new THREE.Vector3(0, 0, -DESTINATION_DISTANCE),
        destinationRadius: DESTINATION_RADIUS,
        approachDistance: APPROACH_RANGE,
        touchdownAltitude: TOUCHDOWN_RANGE,
      },
      {
        onPhaseChange: (next, prev) => {
          this.events.onPhaseChange?.(next, prev);
          if (next === "approach") {
            this.beginApproach();
          }
          if (next === "touchdown") {
            this.beginTouchdown();
          }
          if (next === "landed") {
            this.beginLandedHandoff();
          }
        },
      },
    );

    // Cockpit splat — uses the same record FlightScene used.
    const artemis = COCKPITS.find((c) => c.id === "artemis");
    if (artemis) {
      void this.rig.setCockpitSplat({
        splatUrl: artemis.splatUrl,
        cameraOffset: artemis.pose.cameraOffset,
        splatRotation: artemis.pose.splatRotation,
        splatScale: artemis.pose.splatScale,
        tint: artemis.tint,
        opacity: artemis.opacity,
      });
    }
  }

  setEvents(events: MissionEvents): void {
    this.events = events;
  }

  beginMission(planet: Planet): void {
    this.currentPlanet = planet;
    this.phaseController.forcePhase("liftoff");
    this.phaseController.ignited = false;
    this.liftoffElapsed = 0;
    this.touchdownFiredHandoff = false;
    this.touchdownTween = null;
    this.surfaceFade = 0;
    this.destinationModelLoadId++;
    this.surfaceSplatLoadId++;
    this.clearDestinationModel();
    this.clearSurfaceSplat();

    // Recolour the destination placeholder with the planet's theme so even
    // before the GLB swap it reads as the right body.
    const placeholderMat = this.destinationMesh.material as THREE.MeshStandardMaterial;
    placeholderMat.color = new THREE.Color(planet.theme.mid);
    placeholderMat.emissive = new THREE.Color(planet.theme.dark);

    // Reset ship to launch pad pose.
    const padPos = new THREE.Vector3(0, EARTH_RADIUS + SHIP_PAD_OFFSET, 0);
    const padQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 1, 0),
    );
    this.dynamics.setPose(padPos, padQuat);
    this.dynamics.frozen = true; // unfrozen on ignition

    // ---------- Opening cinematic ----------
    // Auto-ignition: the player never has to press W. The mission
    // immediately launches.
    this.ignited = true;
    this.phaseController.ignited = true;

    // Stage 1: external view framing the rocket on the pad. We need the
    // rig's followShip to be aware of the launch pose so the external
    // anchor is dropped correctly relative to the rocket.
    this.rig.followShip(this.dynamics.ship);
    this.rig.setView("external", true);
    // Pull the camera in close — 2.4 units back, 1.6 up — so the rocket
    // reads as a hero against Earth, not a speck.
    this.rig.dropExternalAnchor(2.4, 1.6);

    this.openingStage = "exterior_intro";
    this.openingElapsed = 0;
  }

  /** Legacy entry point — autopilot-only experience auto-ignites. */
  ignite(): void {
    if (this.ignited) return;
    this.ignited = true;
    this.phaseController.ignited = true;
    this.liftoffElapsed = 0;
  }

  enter(): void {
    this.rig.attachCockpitToCamera();
    if (this.spark && this.spark.parent !== this.scene) {
      this.scene.add(this.spark);
    }
  }

  exit(): void {
    if (this.spark && this.spark.parent === this.scene) {
      this.scene.remove(this.spark);
    }
  }

  /** Set per-frame input (smoothed snapshot from FlightInput). */
  setInput(input: MissionInput): void {
    this.input = input;
  }

  update(deltaSec: number, elapsedSec: number): void {
    this.earth.update(deltaSec, elapsedSec);

    // Stars are placed at world radius 9500; if we never moved them with
    // the ship they'd start to feel "left behind" once the rocket has
    // actually traveled meaningful units. Keep them anchored on the
    // CAMERA position so they always read as the infinitely-far horizon.
    this.starfield.position.copy(this.camera.position);
    this.starfield.rotation.y += deltaSec * 0.001;

    // Liftoff is canned; everything else is on the autopilot.
    if (this.phaseController.phase === "liftoff" && this.ignited) {
      // During the brief "exterior_intro" stage we hold the ship still on
      // the pad so the camera has time to read. After that, the canned
      // liftoff sequence takes over.
      if (this.openingStage === "exterior_intro") {
        // Keep ship pinned to the pad pose; no integration.
        this.autopilotThrottle = 0;
      } else {
        this.driveLiftoff(deltaSec);
      }
    } else if (this.phaseController.phase !== "liftoff") {
      this.runAutopilot(deltaSec);
    }

    // Drive the opening cinematic stage machine.
    this.advanceOpening(deltaSec);

    // Phase machine looks at the post-step ship pose.
    this.phaseController.update(this.dynamics.ship);

    // Surface splat fade-in / out follows phase.
    this.updateSurfaceFade(deltaSec);

    // Camera shake amplitude per phase (pre-cached `feel` to avoid double
    // call). Throttle here is autopilot-driven, so use the dynamic
    // throttle the rig is rendering with rather than the (now-ignored)
    // player input.
    const feel = this.phaseController.feel();
    const shakeAmp = 0.022 * feel.shakeScale * this.autopilotThrottle;
    this.computeShake(elapsedSec, shakeAmp, this._scratchShake);
    this.rig.setExtraShake(this._scratchShake);
    this.rig.setThrottle(this.autopilotThrottle, 0);
    // Head-look uses the player's mouse input; ship steering is autopilot.
    this.rig.setHeadLook(this.input.headLookYaw, this.input.headLookPitch);

    // Rig follows the (just-updated) ship.
    this.rig.followShip(this.dynamics.ship);

    // Touchdown camera tween — handoff to walking happens on completion.
    if (this.touchdownTween) {
      this.touchdownTween.update(deltaSec);
    }

    // Drive the rig (camera composition + view-mode dolly).
    this.rig.update(deltaSec, elapsedSec);

    // Camera altitude floor: at the launch pad the ship's nose points up, so
    // "behind the ship" (the chase / external default offset) ends up
    // *under* the launch pad — i.e. inside Earth. We push the camera back
    // above the surface plus a small margin so the player never sees the
    // inside of the planet.
    const minRadius = EARTH_RADIUS + 0.6;
    const camRadius = this.camera.position.length();
    if (camRadius < minRadius) {
      // Lift toward the ship if possible (so the framing still makes sense),
      // otherwise push radially outward.
      const liftTarget = this._scratchVec
        .copy(this.camera.position)
        .normalize()
        .multiplyScalar(minRadius);
      this.camera.position.copy(liftTarget);
      // Make sure we're still looking at something sensible — ship in chase/
      // external, forward in cockpit.
      const ship = this.dynamics.ship;
      if (this.rig.viewMode !== "cockpit") {
        this.camera.lookAt(ship.position);
      }
    }

    // Avoid unused warning while smoothstep is held in reserve for future
    // polish (e.g. atmosphere fade).
    void smoothstep;
    void dampVec3;
    void easeOutCubic;
    void damp;
    void noise1D;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.rig.dispose();
    this.earth.dispose();
    this.clearDestinationModel();
    this.clearSurfaceSplat();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else m?.dispose?.();
    });
  }

  /* ============================================================
   * Telemetry for HUD
   * ============================================================ */

  getTelemetry(): MissionTelemetry {
    const ship = this.dynamics.ship;
    const altitudeAboveEarth =
      this.phaseController.altitudeAboveEarth(ship);
    const altitudeAboveDest =
      this.phaseController.altitudeAboveDestination(ship);
    const range = this.phaseController.rangeToDestination(ship);

    this._scratchEuler.setFromQuaternion(ship.quaternion, "YXZ");
    return {
      phase: this.phaseController.phase,
      speedKmS: this.dynamics.speedKmS(),
      altitudeKm: altitudeAboveEarth * WORLD_SCALE_KM_PER_UNIT,
      rangeKm: range * WORLD_SCALE_KM_PER_UNIT,
      destinationAltitudeKm: altitudeAboveDest * WORLD_SCALE_KM_PER_UNIT,
      shipPitchDeg: THREE.MathUtils.radToDeg(this._scratchEuler.x),
      shipRollDeg: THREE.MathUtils.radToDeg(this._scratchEuler.z),
      shipYawDeg: THREE.MathUtils.radToDeg(this._scratchEuler.y),
    };
  }

  /* ============================================================
   * View
   * ============================================================ */

  toggleView(): void {
    this.rig.toggleView();
  }
  setView(mode: ViewMode, immediate = false): void {
    this.rig.setView(mode, immediate);
  }
  get viewMode(): ViewMode {
    return this.rig.viewMode;
  }

  /* ============================================================
   * Autopilot
   * ============================================================ */

  /**
   * Auto-fly the ship from cruise → approach → touchdown. The player's
   * mouse stays alive for head-look but doesn't steer the rocket — the
   * autopilot points the nose at the destination, holds cruise throttle,
   * eases off as it approaches, and tilts vertical for a soft hover-down
   * landing.
   */
  private runAutopilot(deltaSec: number): void {
    const ship = this.dynamics.ship;
    const phase = this.phaseController.phase;
    const dest = this.phaseController.destinationCenter;
    const destRadius = this.phaseController.destinationRadius;

    // Desired-forward direction in world space.
    let throttle = 1.0;
    if (phase === "touchdown") {
      // Nose UP relative to the destination's surface (radial outward).
      this._scratchDesiredFwd
        .copy(ship.position)
        .sub(dest)
        .normalize();
      const aglDest = this.phaseController.altitudeAboveDestination(ship);
      // Ramp throttle from 0.45 (just enough to slow the descent) at
      // altitude=touchdownRange down to 0 at altitude=0 — gentle
      // hover-and-settle.
      throttle = clamp01(aglDest / TOUCHDOWN_RANGE) * 0.45;
    } else {
      // Cruise / approach: point at the destination centre.
      this._scratchDesiredFwd
        .copy(dest)
        .sub(ship.position)
        .normalize();

      if (phase === "approach") {
        // Decelerate as we close in: range scales from APPROACH_RANGE
        // (full cruise) down to (destRadius * 1.4) (drop to 35%).
        const range = this.phaseController.rangeToDestination(ship);
        const innerStop = destRadius * 1.4;
        const denom = Math.max(0.001, APPROACH_RANGE - innerStop);
        const t = clamp01((range - innerStop) / denom);
        throttle = 0.35 + 0.65 * t;
      }
    }

    // Slerp ship attitude toward the desired forward. Damp toward the
    // target with a half-life of ~0.4s so the ship banks smoothly without
    // overshooting.
    this._scratchDesiredQuat.setFromUnitVectors(
      _shipForwardLocal,
      this._scratchDesiredFwd,
    );
    const slerpT = 1 - Math.exp(-2.5 * deltaSec);
    ship.quaternion.slerp(this._scratchDesiredQuat, slerpT);

    // Run dynamics with autopilot throttle, no rotational rate input
    // (we steered above by directly slerping the quaternion).
    this.autopilotThrottle = throttle;
    this.dynamics.frozen = false;
    this.dynamics.step(
      { pitchRate: 0, yawRate: 0, rollRate: 0, throttle, boost: 0 },
      deltaSec,
    );
  }

  /* ============================================================
   * Opening cinematic
   * ============================================================ */

  /**
   * Drives the four-stage opening sequence. Called every frame while the
   * mission is active.
   */
  private advanceOpening(dt: number): void {
    if (this.openingStage === "cockpit") return;
    this.openingElapsed += dt;

    switch (this.openingStage) {
      case "exterior_intro": {
        // Hold framing for EXTERIOR_INTRO_SEC, with a slow inward dolly
        // (camera pulls toward the rocket) so the shot doesn't feel
        // static while we wait.
        const t = clamp01(
          this.openingElapsed / MissionScene.EXTERIOR_INTRO_SEC,
        );
        const back = 2.4 + (2.0 - 2.4) * t;       // 2.4 → 2.0
        const up = 1.6 + (1.4 - 1.6) * t;          // 1.6 → 1.4
        this.rig.dropExternalAnchor(back, up);

        if (this.openingElapsed >= MissionScene.EXTERIOR_INTRO_SEC) {
          this.openingStage = "ascending_external";
          this.openingElapsed = 0;
          // Real ignition — the canned liftoff begins on the next frame.
          this.liftoffElapsed = 0;
        }
        break;
      }
      case "ascending_external": {
        // Trail the climbing rocket. As the ship rises and tilts, the
        // anchor "back" tightens so the camera approaches the cockpit
        // window — set up for the cockpit fade-in.
        const climbT = clamp01(
          this.liftoffElapsed / this.LIFTOFF_DURATION,
        );
        const back = 2.0 + (1.4 - 2.0) * climbT;   // 2.0 → 1.4
        const up = 1.4 + (1.0 - 1.4) * climbT;     // 1.4 → 1.0
        this.rig.dropExternalAnchor(back, up);

        if (this.liftoffElapsed >= this.LIFTOFF_DURATION) {
          // Time to crossfade into the cockpit. The unified view tween
          // handles the camera move; we kick off a parallel splat fade.
          this.openingStage = "blend_to_cockpit";
          this.openingElapsed = 0;
          this.rig.setView("cockpit");
          this.rig.beginCinematicCockpitFade(MissionScene.COCKPIT_FADE_SEC);
        }
        break;
      }
      case "blend_to_cockpit": {
        if (this.openingElapsed >= MissionScene.COCKPIT_FADE_SEC) {
          this.openingStage = "cockpit";
          this.openingElapsed = 0;
        }
        break;
      }
    }
  }

  /* ============================================================
   * Liftoff sequence
   * ============================================================ */

  private driveLiftoff(deltaSec: number): void {
    this.dynamics.frozen = true;
    this.liftoffElapsed = Math.min(
      this.LIFTOFF_DURATION,
      this.liftoffElapsed + deltaSec,
    );
    const t = this.liftoffElapsed / this.LIFTOFF_DURATION;
    const eased = easeOutCubic(t);

    // Earth-radial direction at the launch pad (initially +Y).
    const ship = this.dynamics.ship;
    this._scratchRadial.copy(ship.position).normalize();

    // Vertical climb height (units): exponential build, peaks at ~12 units
    // above pad by the end of the canned ramp.
    const altitudeAbovePad = SHIP_PAD_OFFSET + eased * 12;
    const newPos = this._scratchVec
      .copy(this._scratchRadial)
      .multiplyScalar(EARTH_RADIUS + altitudeAbovePad);

    // Gravity-turn arc: as t advances, tilt the nose from +Y toward -Z so
    // the ship leaves Earth pointed at the destination.
    const tiltAngle = eased * (Math.PI / 2.4); // up to ~75°
    const startQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 1, 0),
    );
    const endQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, Math.cos(tiltAngle), -Math.sin(tiltAngle)).normalize(),
    );
    const q = startQ.clone().slerp(endQ, eased);

    ship.position.copy(newPos);
    ship.quaternion.copy(q);
    // Velocity is implied by the canned position change.
    ship.velocity
      .copy(this._scratchRadial)
      .multiplyScalar(eased * 12); // approximate derivative

    if (t >= 1) {
      // Hand off control: restore frozen, give the player a small initial
      // velocity along their forward axis so the cruise feels seamless.
      this.dynamics.frozen = false;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        ship.quaternion,
      );
      ship.velocity.copy(forward).multiplyScalar(8); // ~800 km/s initial cruise
    }
  }

  /* ============================================================
   * Approach + landing
   * ============================================================ */

  private beginApproach(): void {
    if (!this.currentPlanet?.modelUrl) return;
    void this.loadDestinationModel(
      this.currentPlanet.modelUrl,
      ++this.destinationModelLoadId,
    );
  }

  private async loadDestinationModel(
    url: string,
    loadId: number,
  ): Promise<void> {
    try {
      const model = await loadNormalizedGltfModel(url, DESTINATION_RADIUS * 2);
      if (loadId !== this.destinationModelLoadId) {
        disposeObjectTree(model);
        return;
      }
      this.clearDestinationModel();
      model.position.copy(this.destinationMesh.position);
      this.destinationModel = model;
      this.destinationGroup.add(model);
      this.destinationMesh.visible = false;
    } catch (err) {
      console.warn("[MissionScene] destination GLB failed", err);
    }
  }

  private clearDestinationModel(): void {
    if (!this.destinationModel) return;
    this.destinationGroup.remove(this.destinationModel);
    disposeObjectTree(this.destinationModel);
    this.destinationModel = null;
    this.destinationMesh.visible = true;
  }

  private beginTouchdown(): void {
    if (!this.spark || !this.currentPlanet) return;
    void this.loadSurfaceSplat(
      this.currentPlanet.splatUrl,
      ++this.surfaceSplatLoadId,
    );
  }

  private async loadSurfaceSplat(
    url: string,
    loadId: number,
  ): Promise<void> {
    try {
      const splat = new SplatMesh({ url });
      splat.quaternion.set(1, 0, 0, 0); // OpenCV→OpenGL Y-flip
      splat.position.set(0, 0, 0);
      // Splat is added to a group anchored at the destination's centre. The
      // group's "up" vector is the radial direction pointing from dest to
      // the camera; we orient at fade-in time.
      await splat.initialized;
      if (loadId !== this.surfaceSplatLoadId) {
        splat.dispose?.();
        return;
      }
      this.surfaceSplat = splat;
      // Place the splat just outside the planet's surface along the radial
      // toward the ship's current direction so the player descends "into"
      // the splat.
      this.surfaceSplatGroup.position.copy(this.destinationMesh.position);
      this.surfaceSplatGroup.add(splat);
    } catch (err) {
      console.warn("[MissionScene] surface splat failed", err);
    }
  }

  private clearSurfaceSplat(): void {
    if (!this.surfaceSplat) return;
    this.surfaceSplatGroup.remove(this.surfaceSplat);
    this.surfaceSplat.dispose?.();
    this.surfaceSplat = null;
  }

  private updateSurfaceFade(dt: number): void {
    const target = this.phaseController.phase === "touchdown" ||
      this.phaseController.phase === "landed"
      ? 1
      : 0;
    this.surfaceFade = damp(this.surfaceFade, target, 1.6, dt);
    if (this.surfaceSplat) {
      this.surfaceSplat.opacity = this.surfaceFade;
    }
  }

  private beginLandedHandoff(): void {
    if (this.touchdownFiredHandoff) return;
    this.touchdownFiredHandoff = true;
    // Snap velocity to zero so the camera handoff is rock-steady.
    this.dynamics.ship.velocity.set(0, 0, 0);
    this.dynamics.frozen = true;

    // Tween covers a brief 1.2s "cabin settle" before the handoff fires.
    this.touchdownTween = new Tween(1.2, easeOutCubic, () => {}, () => {
      const ship = this.dynamics.ship;
      this.events.onTouchdown?.({
        spawnPose: {
          position: ship.position.clone(),
          quaternion: ship.quaternion.clone(),
        },
      });
    });
    this.touchdownTween.start();
  }

  private computeShake(
    elapsedSec: number,
    amplitude: number,
    out: THREE.Vector3,
  ): void {
    if (amplitude <= 0) {
      out.set(0, 0, 0);
      return;
    }
    const shake = (seed: number) =>
      (Math.sin(elapsedSec * (28 + seed * 4) + seed) +
        Math.sin(elapsedSec * (61 + seed * 7) + seed * 1.7)) *
      0.5 *
      amplitude;
    out.set(shake(0), shake(1), shake(2) * 0.4);
  }

  /* ============================================================
   * Debug
   * ============================================================ */

  getDebugSnapshot(): {
    phase: MissionPhase;
    feel: PhaseFeel;
    ignited: boolean;
    ship: ShipState;
    surfaceFade: number;
  } {
    return {
      phase: this.phaseController.phase,
      feel: this.phaseController.feel(),
      ignited: this.ignited,
      ship: this.dynamics.ship,
      surfaceFade: this.surfaceFade,
    };
  }
}

