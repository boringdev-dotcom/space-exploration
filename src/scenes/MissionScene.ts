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
import { createSpaceDust, type SpaceDust } from "../util/spaceDust";
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

// Roll-stabilization references for the autopilot's look-at attitude.
const _missionWorldUp = new THREE.Vector3(0, 1, 0);
const _missionUpFallback = new THREE.Vector3(0, 0, -1);
const _missionLookEye = new THREE.Vector3();
const _missionLookTarget = new THREE.Vector3();
const _scratchTouchTarget = new THREE.Vector3();

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export interface MissionInput extends FlightDynamicsInput {
  /** Head-look yaw (radians) — passed straight to CockpitRig in cockpit mode. */
  headLookYaw: number;
  /** Head-look pitch (radians). */
  headLookPitch: number;
}

/**
 * Held flight-assist booleans driven by the player. All clear unless the
 * player is holding the corresponding key. Mutually exclusive in priority:
 * brake > retrograde > prograde > level.
 */
export interface FlightAssist {
  brake: boolean;
  retrograde: boolean;
  prograde: boolean;
  level: boolean;
}

/**
 * Control mode for the player's ship.
 *
 *   - `auto`     : Existing scripted autopilot (cinematic preserve).
 *   - `manual`   : Player owns pitch/yaw/roll/throttle; phase machine
 *                  still observes ship state for HUD/audio cues.
 *   - `free-fly` : Manual + phase machine paused. Player can fly anywhere
 *                  in the renderable region (soft tether at 10000u).
 */
export type ControlMode = "auto" | "manual" | "free-fly";

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
  /** Fired whenever {@link MissionScene.setControlMode} or the toggles change the mode. */
  onControlModeChange?: (next: ControlMode, prev: ControlMode) => void;
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
  private spaceDust: SpaceDust;
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

  /** Held assist booleans. Cleared every frame from the input snapshot. */
  private assist: FlightAssist = {
    brake: false,
    retrograde: false,
    prograde: false,
    level: false,
  };

  /** Current control mode. See {@link ControlMode}. */
  private _controlMode: ControlMode = "auto";

  private liftoffElapsed = 0;
  private readonly LIFTOFF_DURATION = 6;
  /** Reduced canned-liftoff duration once the player has taken control. */
  private readonly LIFTOFF_DURATION_QUICK = 2;

  /** Latest autopilot throttle value (0..2) — used for plume + shake feel. */
  private autopilotThrottle = 0;
  /** Last frame's boost (for edge-detection of boost engage). */
  private lastBoost = 0;
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
  private readonly _scratchLookMatrix = new THREE.Matrix4();

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

    // Streaming space dust — close-range particles that sweep past the
    // cockpit window so the player visually feels the ship moving even
    // when the destination is still small ahead. Cheap; ~600 particles.
    this.spaceDust = createSpaceDust({
      count: 600,
      radius: 6,
      length: 120,
      size: 0.06,
    });
    this.scene.add(this.spaceDust.points);

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
    this.phaseController.paused = false;
    this.liftoffElapsed = 0;
    this.touchdownFiredHandoff = false;
    this.touchdownTween = null;
    this.surfaceFade = 0;
    // Each new mission starts in autopilot. The player flips to manual
    // by touching any flight key (wired in SceneManager).
    if (this._controlMode !== "auto") {
      const prev = this._controlMode;
      this._controlMode = "auto";
      this.events.onControlModeChange?.("auto", prev);
    }
    this.assist = { brake: false, retrograde: false, prograde: false, level: false };
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

  /**
   * Skip the cruise + approach and jump the ship to a hover-down pose
   * just above the destination, then let the touchdown autopilot settle
   * it. Triggered by the in-flight "Skip to Landing" button.
   */
  skipToLanding(): void {
    if (this.phaseController.phase === "landed") return;
    const dest = this.phaseController.destinationCenter;
    const destRadius = this.phaseController.destinationRadius;

    // Place the ship ~6 units above the destination surface along a
    // stable radial (we pick +Y so the world lighting reads cleanly),
    // pointed radially outward.
    const radial = new THREE.Vector3(0, 1, 0); // arbitrary stable radial
    const pos = new THREE.Vector3()
      .copy(radial)
      .multiplyScalar(destRadius + 5)
      .add(dest);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      radial,
    );
    this.dynamics.setPose(pos, quat);
    this.dynamics.frozen = true;
    this.dynamics.ship.velocity.set(0, 0, 0);

    // Force the cinematic to settled cockpit so the autopilot owns the
    // descent without any opening-stage scaffolding interfering.
    this.openingStage = "cockpit";
    this.rig.setView("cockpit");

    // Drop straight into touchdown phase — the new touchdown autopilot
    // (damped position move toward the surface) handles the rest.
    this.phaseController.forcePhase("touchdown");

    // Pre-load the surface splat now so it's ready by the time we settle.
    this.beginTouchdown();
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

  /** Set per-frame held-assist flags (brake, retrograde, prograde, level). */
  setFlightAssist(assist: FlightAssist): void {
    this.assist = assist;
  }

  /** Read current control mode (auto / manual / free-fly). */
  get controlMode(): ControlMode {
    return this._controlMode;
  }

  /**
   * Atmospheric proximity factor (0..1) — climbs as the ship approaches
   * either Earth or the destination surface. Used by the post-fx
   * pipeline to push bloom + vignette during atmospheric entry, selling
   * the "burning into atmosphere" feel without a custom shader.
   */
  getAtmosphericProximity(): number {
    const ship = this.dynamics.ship;
    const altE = this.phaseController.altitudeAboveEarth(ship);
    const altD = this.phaseController.altitudeAboveDestination(ship);
    // Ramp from 0 at 30u AGL up to 1 at the surface (0u). Take the
    // smallest of the two so we react to whichever body is closer.
    const factor = (alt: number): number => {
      if (alt <= 0) return 1;
      if (alt >= 30) return 0;
      const t = 1 - alt / 30;
      return t * t * (3 - 2 * t); // smoothstep
    };
    return Math.max(factor(altE), factor(altD));
  }

  /** Set the control mode explicitly. Idempotent; emits onControlModeChange. */
  setControlMode(mode: ControlMode): void {
    if (mode === this._controlMode) return;
    const prev = this._controlMode;
    this._controlMode = mode;
    // Phase machine paused only in free-fly so the player can drift past
    // the destination without phase progression interfering.
    this.phaseController.paused = mode === "free-fly";
    // Returning from free-fly to manual/auto resumes the phase machine; if
    // the ship is far from any body, snap phase to cruise so the HUD is
    // sensible.
    if (prev === "free-fly" && mode !== "free-fly") {
      const earthAlt = this.phaseController.altitudeAboveEarth(this.dynamics.ship);
      if (earthAlt > 8) {
        this.phaseController.forcePhase("cruise");
      }
    }
    // If we're toggling auto → manual mid-canned-liftoff, end the canned arc
    // so the player has authority immediately.
    if (mode !== "auto" && this.dynamics.frozen && this.phaseController.phase === "liftoff") {
      this.exitCannedLiftoff();
    }
    this.events.onControlModeChange?.(mode, prev);
  }

  /** Toggle between manual and auto. Free-fly is unaffected. */
  toggleAutopilot(): void {
    if (this._controlMode === "free-fly") {
      // Tab from free-fly returns to manual (preserves player ownership).
      this.setControlMode("manual");
      return;
    }
    this.setControlMode(this._controlMode === "auto" ? "manual" : "auto");
  }

  /** Toggle free-fly. Releasing free-fly returns to manual. */
  toggleFreeFly(): void {
    this.setControlMode(
      this._controlMode === "free-fly" ? "manual" : "free-fly",
    );
  }

  /**
   * Force-end the canned liftoff arc. Frees the dynamics integrator and
   * gives the ship a small forward impulse so the player doesn't sit
   * stationary the moment they take control.
   */
  private exitCannedLiftoff(): void {
    const ship = this.dynamics.ship;
    this.dynamics.frozen = false;
    // Forward impulse along ship-forward, scaled by where we are in the
    // canned arc. Early exit = small impulse, late exit = full cruise impulse.
    const t = clamp01(this.liftoffElapsed / this.LIFTOFF_DURATION_QUICK);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quaternion);
    ship.velocity.copy(fwd).multiplyScalar(4 + 4 * t);
    // Make sure the phase machine can advance out of liftoff once altitude
    // climbs past the threshold.
    this.liftoffElapsed = this.LIFTOFF_DURATION;
  }

  update(deltaSec: number, elapsedSec: number): void {
    this.earth.update(deltaSec, elapsedSec);

    // Stars are placed at world radius 9500; if we never moved them with
    // the ship they'd start to feel "left behind" once the rocket has
    // actually traveled meaningful units. Keep them anchored on the
    // CAMERA position so they always read as the infinitely-far horizon.
    this.starfield.position.copy(this.camera.position);
    this.starfield.rotation.y += deltaSec * 0.001;

    // Streaming dust: respawns particles ahead of the ship as they sweep
    // past, so the player feels the ship moving. Hide once landed (ship
    // velocity is zero so respawning is wasted work). At cruise speed
    // we widen the particles + bump opacity so the dust streaks read as
    // wind-blur (B4 in PLAN.md).
    const phase = this.phaseController.phase;
    const dustVisible = phase !== "landed";
    this.spaceDust.points.visible = dustVisible;
    if (dustVisible) {
      const dustSpeed = this.dynamics.ship.velocity.length();
      const dustNorm = clamp01(dustSpeed / 60);
      this.spaceDust.update(
        this.dynamics.ship.position,
        this.dynamics.ship.forward,
        deltaSec,
        dustNorm,
      );
    }

    // Liftoff is canned in `auto` mode; in manual / free-fly the player
    // takes the stick the moment the opening cinematic completes.
    if (this.phaseController.phase === "liftoff" && this.ignited) {
      // During the brief "exterior_intro" stage we hold the ship still on
      // the pad so the camera has time to read.
      if (this.openingStage === "exterior_intro") {
        this.autopilotThrottle = 0;
      } else if (this._controlMode === "auto") {
        this.driveLiftoff(deltaSec);
      } else {
        // Manual / free-fly during liftoff: skip the canned arc entirely.
        // The dynamics integrator owns the ship from frame zero.
        if (this.dynamics.frozen) this.exitCannedLiftoff();
        this.runFlight(deltaSec);
      }
    } else if (this.phaseController.phase !== "liftoff") {
      this.runFlight(deltaSec);
    }

    // Drive the opening cinematic stage machine.
    this.advanceOpening(deltaSec);

    // Phase machine looks at the post-step ship pose.
    this.phaseController.update(this.dynamics.ship);

    // Surface splat fade-in / out follows phase.
    this.updateSurfaceFade(deltaSec);

    // Camera shake amplitude per phase (pre-cached `feel` to avoid double
    // call). Inside the cockpit (camera = pilot's head) we kill shake
    // entirely so the player doesn't get motion-sick — only the chase
    // and external cameras vibrate with the engines.
    const feel = this.phaseController.feel();
    const exteriorWeight = 1 - this.rig.cockpitWeight;
    const shakeAmp =
      0.022 * feel.shakeScale * this.autopilotThrottle * exteriorWeight;
    this.computeShake(elapsedSec, shakeAmp, this._scratchShake);
    this.rig.setExtraShake(this._scratchShake);

    // Speed factor used by FOV bias + plume length (B1, B5).
    const dyn = this.dynamics;
    const speed = dyn.ship.velocity.length();
    const speedNorm = clamp01(speed / 60);
    this.rig.setThrottle(this.autopilotThrottle, this.input.boost, speedNorm);
    this.rig.setSpeedFovBias(speedNorm * 4);

    // Boost engage edge → +6° FOV punch decaying over 0.4s.
    if (this.input.boost > 0.1 && this.lastBoost <= 0.1) {
      this.rig.pulseBoostFov(6, 0.4);
    }
    this.lastBoost = this.input.boost;

    // Visual roll-into-yaw bank for chase/external (B3). We use the
    // player's commanded yaw rate when in manual; in autopilot the ship
    // is straight-line cruising so there's nothing to bank.
    const yawForBank = this._controlMode === "auto" ? 0 : this.input.yawRate;
    this.rig.setYawRateForBank(yawForBank);

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
    this.spaceDust.dispose();
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
   * Flight loop — autopilot OR manual/free-fly
   * ============================================================ */

  /**
   * Drive the ship one frame. Branches on `_controlMode`:
   *   - `auto`     : runs the existing scripted autopilot (slerp at dest,
   *                  velocity damping in approach, hover-down on touchdown).
   *   - `manual`   : routes the player's input snapshot straight into the
   *                  dynamics integrator. Held-assist (brake / retrograde /
   *                  prograde / level horizon) layers on top.
   *   - `free-fly` : same as manual, plus a soft tether at 10000 units that
   *                  pulls the ship back toward Earth so it can never escape
   *                  the renderable region.
   */
  private runFlight(deltaSec: number): void {
    if (this._controlMode === "auto") {
      this.runAutopilot(deltaSec);
      return;
    }
    this.runManual(deltaSec);
  }

  /**
   * Manual flight: the player's input rate commands drive the dynamics
   * integrator directly. Held-assist (brake/retro/pro/level) takes priority
   * over throttle-driven motion in that order.
   */
  private runManual(deltaSec: number): void {
    const ship = this.dynamics.ship;
    this.dynamics.frozen = false;

    // Held-assist (priority order: brake > retrograde > prograde > level).
    // Each behaviour mutates attitude and/or velocity BEFORE the dynamics
    // step so the player's WASD/throttle still composes naturally on top.
    if (this.assist.brake) {
      // Smooth velocity-kill — `dampVec3` toward zero with a high lambda.
      // Player still has attitude authority (pitch/yaw/roll springs) so
      // they can re-orient while braking.
      const k = 1 - Math.exp(-4.0 * deltaSec);
      ship.velocity.multiplyScalar(1 - k);
      this.autopilotThrottle = 0; // no plume while braking
      this.dynamics.step(
        {
          pitchRate: this.input.pitchRate,
          yawRate: this.input.yawRate,
          rollRate: this.input.rollRate,
          throttle: 0,
          boost: 0,
        },
        deltaSec,
      );
    } else if (this.assist.retrograde && ship.velocity.lengthSq() > 0.0025) {
      // Snap the nose toward -velocity. Useful for "flip and burn".
      this._scratchDesiredFwd.copy(ship.velocity).normalize().negate();
      this.slerpAttitude(this._scratchDesiredFwd, deltaSec, 3.0);
      this.autopilotThrottle = this.input.throttle;
      this.dynamics.step(
        {
          // Suppress player attitude rates so the slerp can settle cleanly.
          pitchRate: 0,
          yawRate: 0,
          rollRate: 0,
          throttle: this.input.throttle,
          boost: this.input.boost,
        },
        deltaSec,
      );
    } else if (this.assist.prograde && ship.velocity.lengthSq() > 0.0025) {
      // Snap the nose toward +velocity. Useful to re-align after rotating.
      this._scratchDesiredFwd.copy(ship.velocity).normalize();
      this.slerpAttitude(this._scratchDesiredFwd, deltaSec, 3.0);
      this.autopilotThrottle = this.input.throttle;
      this.dynamics.step(
        {
          pitchRate: 0,
          yawRate: 0,
          rollRate: 0,
          throttle: this.input.throttle,
          boost: this.input.boost,
        },
        deltaSec,
      );
    } else if (this.assist.level) {
      // Zero roll: keep the current forward, but rebuild the quaternion
      // with world-up as the reference up so any roll component is purged.
      this._scratchDesiredFwd
        .set(0, 0, -1)
        .applyQuaternion(ship.quaternion)
        .normalize();
      this.slerpAttitude(this._scratchDesiredFwd, deltaSec, 4.0);
      this.autopilotThrottle = this.input.throttle;
      this.dynamics.step(
        {
          // Player retains pitch/yaw authority while levelling, but roll
          // is forced.
          pitchRate: this.input.pitchRate,
          yawRate: this.input.yawRate,
          rollRate: 0,
          throttle: this.input.throttle,
          boost: this.input.boost,
        },
        deltaSec,
      );
    } else {
      // Vanilla manual flight — full player authority.
      this.autopilotThrottle = this.input.throttle;
      this.dynamics.step(
        {
          pitchRate: this.input.pitchRate,
          yawRate: this.input.yawRate,
          rollRate: this.input.rollRate,
          throttle: this.input.throttle,
          boost: this.input.boost,
        },
        deltaSec,
      );
    }

    // Soft tether for free-fly: if the player has wandered close to the
    // far plane, apply a gentle radial pull back toward Earth so the
    // scene never disappears off-screen.
    if (this._controlMode === "free-fly") {
      const dist = ship.position.length();
      const SOFT_RADIUS = 10000;
      if (dist > SOFT_RADIUS) {
        const overshoot = (dist - SOFT_RADIUS) / 2000; // 0..1+
        const pull = Math.min(2.0, overshoot * 2.0); // u/s² magnitude
        // Vector from ship → Earth centre, normalized.
        const toEarth = this._scratchDesiredFwd
          .copy(ship.position)
          .normalize()
          .multiplyScalar(-pull * deltaSec);
        ship.velocity.add(toEarth);
      }
    }
  }

  /**
   * Original scripted autopilot: ship pointed at destination through cruise,
   * velocity damped on approach, hover-down on touchdown. Preserved as the
   * default `auto` control mode so the launch cinematic and "hands-off"
   * experience remain intact.
   */
  private runAutopilot(deltaSec: number): void {
    const ship = this.dynamics.ship;
    const phase = this.phaseController.phase;
    const dest = this.phaseController.destinationCenter;
    const destRadius = this.phaseController.destinationRadius;

    if (phase === "cruise") {
      // Cruise: nose at the destination, full thrust until approach.
      this._scratchDesiredFwd
        .copy(dest)
        .sub(ship.position)
        .normalize();
      this.slerpAttitude(this._scratchDesiredFwd, deltaSec, 2.5);
      this.autopilotThrottle = 1.0;
      this.dynamics.frozen = false;
      this.dynamics.step(
        { pitchRate: 0, yawRate: 0, rollRate: 0, throttle: 1.0, boost: 0 },
        deltaSec,
      );
      return;
    }

    if (phase === "approach") {
      // Approach: aim the nose at the destination but DAMPEN velocity so
      // the ship arrives at touchdown range with a low closing speed.
      // Without this damping the ship slams into the planet at full
      // cruise velocity and oscillates between approach/touchdown.
      this._scratchDesiredFwd
        .copy(dest)
        .sub(ship.position)
        .normalize();
      this.slerpAttitude(this._scratchDesiredFwd, deltaSec, 2.5);

      const range = this.phaseController.rangeToDestination(ship);
      const innerStop = destRadius * 1.4;
      const denom = Math.max(0.001, APPROACH_RANGE - innerStop);
      const closeness = 1 - clamp01((range - innerStop) / denom); // 0..1

      // Velocity damping: at the outer edge of approach we keep cruise
      // speed; at the inner edge we damp aggressively (target ~3 u/s
      // closing velocity = 300 km/s, well below touchdown trip speed).
      const dampLambda = 0.4 + 6.5 * closeness; // 0.4..6.9 per second
      const dampFactor = Math.exp(-dampLambda * deltaSec);
      ship.velocity.multiplyScalar(dampFactor);

      // Throttle low; we're mostly coasting + damping. Just enough
      // so the plume doesn't read as "off".
      this.autopilotThrottle = 0.25 * (1 - closeness);
      this.dynamics.frozen = false;
      this.dynamics.step(
        {
          pitchRate: 0,
          yawRate: 0,
          rollRate: 0,
          throttle: this.autopilotThrottle,
          boost: 0,
        },
        deltaSec,
      );
      return;
    }

    if (phase === "touchdown") {
      // Touchdown: orient the ship vertically (nose pointing radially
      // OUTWARD from the destination) for a hover-down landing pose,
      // then directly drive the position downward with a damped
      // approach to touchdownAgl. We don't use the dynamics integrator
      // here — physics-accurate retrograde braking creates the loop
      // that bounces the ship between phases. The "hover-down" model
      // is simple and reliable: every frame, we move toward the touch
      // point with a critically-damped exponential.
      const radial = this._scratchDesiredFwd
        .copy(ship.position)
        .sub(dest)
        .normalize();
      this.slerpAttitude(radial, deltaSec, 2.0);

      // Touch point: radius destRadius + touchdownAgl-of-half along
      // radial. (touchdownAgl = 0.5 in PhaseController; we land just
      // above the surface.)
      const touchPoint = this._scratchDesiredQuat as unknown as THREE.Vector3;
      void touchPoint; // (not actually using the quat scratch as Vec3)
      const targetPos = _scratchTouchTarget
        .copy(radial)
        .multiplyScalar(destRadius + 0.4)
        .add(dest);

      // Damp ship.position toward targetPos; lambda ramps with how
      // close we already are so the final approach is gentle.
      const aglDest = this.phaseController.altitudeAboveDestination(ship);
      const aglFrac = clamp01(aglDest / TOUCHDOWN_RANGE);
      const lambda = 1.6 + (1 - aglFrac) * 1.0;
      const k = 1 - Math.exp(-lambda * deltaSec);
      ship.position.x += (targetPos.x - ship.position.x) * k;
      ship.position.y += (targetPos.y - ship.position.y) * k;
      ship.position.z += (targetPos.z - ship.position.z) * k;

      // Velocity is implicit from the position deltas; damp the stored
      // velocity to zero so the touch is a soft settle.
      ship.velocity.multiplyScalar(Math.exp(-4 * deltaSec));

      // A gentle plume keeps the visual.
      this.autopilotThrottle = 0.15 * aglFrac;
      this.dynamics.frozen = true; // we drove the position above
      return;
    }

    // landed: nothing for us to do; PhaseController/handoff owns it.
    this.autopilotThrottle = 0;
  }

  /** Slerp the ship's quaternion toward the given world-space forward. */
  private slerpAttitude(
    desiredFwd: THREE.Vector3,
    deltaSec: number,
    rate: number,
  ): void {
    // Build the target quaternion as a roll-stabilized look-at matrix.
    // `setFromUnitVectors` computes the SHORTEST-ARC rotation from
    // ship-local forward to `desiredFwd`, which carries an arbitrary roll
    // component that drifts a few milliradians whenever `desiredFwd`
    // changes direction. In the cockpit this drift reads as a faint,
    // continuous "shake" of the world outside the windshield even
    // though the autopilot is supposedly cruising in a straight line.
    // Anchoring the target to a stable world-up zeroes the roll noise.
    const referenceUp = Math.abs(desiredFwd.y) > 0.95
      ? _missionUpFallback
      : _missionWorldUp;
    _missionLookEye.set(0, 0, 0);
    _missionLookTarget.copy(desiredFwd);
    this._scratchLookMatrix.lookAt(
      _missionLookEye,
      _missionLookTarget,
      referenceUp,
    );
    this._scratchDesiredQuat.setFromRotationMatrix(this._scratchLookMatrix);
    const slerpT = 1 - Math.exp(-rate * deltaSec);
    this.dynamics.ship.quaternion.slerp(this._scratchDesiredQuat, slerpT);
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

