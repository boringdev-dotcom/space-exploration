import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import type { Planet } from "../data/planets";
import type { SurfaceDebugSnapshot } from "../hud/debugHud";
import {
  ARTEMIS_ROCKET_GLB_URL,
  CYBERTRUCK_GLB_URL,
  isMockSplatUrl,
} from "../data/assetUrls";
import { createStarfield } from "../util/starfield";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import { damp, dampAngle, dampVec3, noise1D, smoothstep } from "../util/feel";
import {
  createRobotaxiPhysics,
  type RobotaxiPhysics,
} from "../util/robotaxiPhysics";

export type SurfaceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

type LockListener = (locked: boolean) => void;

export interface SurfaceRocketInteractionSnapshot {
  ready: boolean;
  loading: boolean;
  boarding: boolean;
  distance: number;
  inRange: boolean;
  hintVisible: boolean;
  boardRange: number;
  hintRange: number;
  currentPlanetId: string | null;
}

/**
 * Mars Robotaxi state machine. The player summons a Tesla Cybertruck with
 * a HUD button; the truck spawns far out on the horizon, drives in along a
 * cubic-Hermite arrival path, pulls up alongside the player, pauses to
 * "board" them, runs a racetrack-shaped tour, returns to the exact pickup
 * spot, pauses to drop them off, then drives away out of the scene.
 *
 * The publicly-visible high-level states (used by the HUD) are kept stable
 * so the surface HUD doesn't need to know about the new internal sub-phases:
 *
 *   idle       — robotaxi inactive (default)
 *   summoning  — truck driving in OR stopped at the pickup waiting for the
 *                player to board (camera handoff into the cab)
 *   touring    — player is riding the loop OR the truck is heading back to
 *                the pickup at the end of the loop
 *   ending     — truck stopped at the dropoff doing the camera handoff back
 *                to walk mode, OR rolling away from the scene
 *
 * Internally, `robotaxiPhase` tracks finer-grained sub-states so the driver
 * code can model the actual choreography of an arrival/board/cruise/return/
 * dropoff/depart cycle.
 */
export type RobotaxiState = "idle" | "summoning" | "touring" | "ending";
type RobotaxiPhase =
  | "idle"
  | "arriving"   // driving from spawn → arrival pose
  | "boarding"   // stopped at arrival, camera gliding into cab
  | "cruising"   // running the tour loop
  | "returning"  // tour finished, driving back to the pickup
  | "dropoff"    // stopped at arrival, camera gliding back to walk mode
  | "departing"; // driving forward away from the scene, then despawn

export interface SurfaceRobotaxiSnapshot {
  /** Available right now? Currently means "we are on Mars, splat ready". */
  available: boolean;
  /** Current state — drives the HUD button copy. */
  state: RobotaxiState;
  /** Distance from player to truck (m) — null when the truck is hidden. */
  truckDistance: number | null;
  /** Tour timer 0..1 — drives the progress bar in the HUD. */
  tourProgress: number;
}

const ROCKET_LANDING_POSITION = new THREE.Vector3(4.2, 0, -9.6);
const ROCKET_BOARD_RANGE = 12;
const ROCKET_HINT_RANGE = 12;
const ROCKET_TARGET_DIAMETER = 5.25;
const ENTRY_REVEAL_SEC = 1.6;

// Robotaxi tunables. The truck still moves along authored paths, but the
// path samples are cubic Hermite curves with controllable end tangents,
// the speed is shaped by upcoming curvature (slow into turns, fast on
// straights), and heading lags the path tangent by one steering-input
// time constant so cornering reads like a real vehicle leaning into a
// turn instead of a point glued to a spline.
const ROBOTAXI_TARGET_LENGTH = 4.8;
/** How far away the truck spawns. Close enough that the player sees the
 *  whole arrival without having to wait, far enough that the Hermite
 *  arrival curve has room to bend gracefully into the curbside pose. */
const ROBOTAXI_SPAWN_DISTANCE = 20;
/** Shared contact plane for walking, floor visuals, Rapier, tracks, and GLBs. */
const SURFACE_GROUND_Y = 0;
/** Main floor sits just below the contact plane so decals/tracks never z-fight it. */
const SURFACE_FLOOR_Y = SURFACE_GROUND_Y - 0.012;
/** Decals/tracks ride just above the contact plane. */
const SURFACE_DECAL_Y = SURFACE_GROUND_Y + 0.018;
const ROBOTAXI_GROUND_Y = SURFACE_GROUND_Y;
const ROBOTAXI_MODEL_YAW_OFFSET = Math.PI;
/**
 * Where the truck stops to pick the player up: a curbside spot a few
 * meters in front of the player and a step to one side, with its nose
 * pointed in the player's forward direction. The same spot is used for
 * drop-off, so the player exits exactly where they got in.
 */
const ROBOTAXI_PICKUP_FORWARD = 5.0;
const ROBOTAXI_PICKUP_SIDE = 2.6;
/** Top cruise speed on a long straight (m/s). */
const ROBOTAXI_MAX_SPEED = 5.4;
/** Target speed in the middle of a tight corner. */
const ROBOTAXI_CORNER_SPEED = 2.55;
/** Final crawl speed when easing into the pickup or dropoff. */
const ROBOTAXI_APPROACH_SPEED = 1.35;
/** Tour duration before the truck auto-returns to the pickup (sec). */
const ROBOTAXI_TOUR_DURATION_SEC = 36;
/**
 * Racetrack-shaped tour: a rounded rectangle centred on the pickup spot.
 * Long straights give the truck somewhere to actually accelerate.
 */
const ROBOTAXI_TOUR_HALF_X = 26;
const ROBOTAXI_TOUR_HALF_Z = 17;
const ROBOTAXI_TOUR_CORNER_RADIUS = 11;
const ROBOTAXI_TOUR_PATH_LENGTH =
  // Perimeter of a rounded rectangle = 2*(2a + 2b - 4r) + 2*pi*r
  // where a,b are half-widths along the principal axes and r is corner radius.
  4 * (ROBOTAXI_TOUR_HALF_X + ROBOTAXI_TOUR_HALF_Z - 2 * ROBOTAXI_TOUR_CORNER_RADIUS) +
  2 * Math.PI * ROBOTAXI_TOUR_CORNER_RADIUS;
/** Chase-camera offsets relative to the truck root. Eye height is generous
 * because Marble splats have noisy upper geometry — staying clearly above
 * the player walking head-height (1 m) avoids ducking through dust splats. */
const ROBOTAXI_RIDE_EYE_HEIGHT = 5.2;
const ROBOTAXI_RIDE_EYE_OFFSET_Z = 9.2;
const ROBOTAXI_RIDE_LOOKAHEAD = 14;
/** Floor for the chase camera in absolute world Y, so we never drop below
 * the player's normal eye plane regardless of where the truck root sits. */
const ROBOTAXI_RIDE_MIN_CAMERA_Y = 3.6;
/** When the chassis is at rest with weight on its wheels, the chassis
 * centre sits about this far above the ground plane. The root group
 * tracks chassis_y minus this constant so the visible wheels touch the
 * ground at rest, with suspension travel showing through naturally
 * during cornering. */
const ROBOTAXI_CHASSIS_TO_ROOT_Y = 1.38;
/** Pure-pursuit lookahead distance (m). Bigger = lazier turn-in. */
const ROBOTAXI_PURSUIT_LOOKAHEAD = 7.25;
/** Steering proportional gain mapping heading error → wheel angle. */
const ROBOTAXI_STEER_GAIN = 0.95;
/** Engine force per (m/s) of speed error when accelerating. */
const ROBOTAXI_ENGINE_GAIN = 310;
/** Brake impulse per (m/s) of speed overshoot. */
const ROBOTAXI_BRAKE_GAIN = 46;
/** Pause durations for getting in / getting out (sec). */
const ROBOTAXI_BOARDING_PAUSE_SEC = 1.5;
const ROBOTAXI_DROPOFF_PAUSE_SEC = 1.4;
/** Camera-only easing window during the handoff portions of board/dropoff. */
const ROBOTAXI_CAMERA_HANDOFF_SEC = 1.15;
/** How far the truck rolls before despawning at the end of departing. */
const ROBOTAXI_DEPART_DISTANCE = 70;
const ROBOTAXI_LOOK_YAW_LIMIT = Math.PI * 0.86;
const ROBOTAXI_LOOK_PITCH_LIMIT = 0.45;
// Only Mars supports robotaxi today — the Cybertruck on Luna's regolith
// would just look weird.
const ROBOTAXI_PLANETS = new Set(["mars"]);

/** Tiny deterministic PRNG so each planet's procedural rockfield is stable. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Surface exploration scene — loads a Gaussian splat world via Spark.js
 * and lets the user walk around with first-person controls.
 */
export class SurfaceScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private spark: SparkRenderer;
  private canvas: HTMLCanvasElement;
  private controls: PointerLockControls;

  private splat: SplatMesh | null = null;
  private _status: SurfaceStatus = "idle";
  private _progress = 0;
  private _splatUrl: string | null = null;
  private _lastError: string | null = null;
  private lockListeners: LockListener[] = [];

  // Procedural fallback surface used when the planet's `splatUrl` still
  // points at the Spark sample splat (i.e. `worlds:mock` was used instead
  // of `worlds:generate`). A simple tinted ground plane + starfield beats
  // dropping the player inside a giant butterfly demo asset.
  private fallbackGroup: THREE.Group | null = null;

  // Touchdown spawn pose used to be persisted here so the player would
  // appear "wherever the ship landed". The ship's mission-space transform
  // isn't a usable surface-space transform — the Marble splat scan origin
  // sits at world (0, 0, 0) regardless of where the destination planet is
  // in mission space, and the camera's far plane is 1000 — so re-using the
  // mission pose put the camera completely outside the splat and nothing
  // rendered. We now always spawn at the Marble scan origin (see
  // `resetCameraPose`) and `setSpawnPose` is intentionally a no-op.

  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private moveUp = false;
  private moveDown = false;
  private sprint = false;

  // Smooth movement model (ported from gaussian-splat-character-controller).
  // Velocity is lerped toward the desired direction every frame using a
  // frame-rate-independent factor `1 - pow(smoothing, 0.116)`. Higher
  // `velocityXZSmoothing` = floatier; `accelerationTimeGrounded` further
  // damps the response to avoid jitter on quick taps.
  private readonly walkSpeed = 4.5;
  private readonly sprintMul = 2.2;
  private readonly verticalSpeed = 3.0;
  private readonly velocityXZSmoothing = 0.08;
  private readonly accelerationTimeGrounded = 0.025;
  private readonly velocityMin = 0.0001;
  private readonly horizontalVelocity = new THREE.Vector3();
  private verticalVelocity = 0;

  // Sprint FOV ramp. The base 75° matches Marble's official world viewer so
  // perspective and framing line up with the marble.worldlabs.ai preview the
  // user saw when they generated the world.
  private readonly normalFov = 75;
  private readonly sprintFov = 82;

  // Marble's viewer initialises the camera at the scan origin (0, 0, 0)
  // looking at (0, 0, -10), then — once the splat has finished loading —
  // animates it up to (0, 1, 0) looking at (0, 1, -10). That 1-unit lift
  // is what makes the framing look like "you're standing on the surface"
  // instead of "your eye is buried in the ground". We mirror that final
  // pose exactly so the spawn matches marble.worldlabs.ai byte-for-byte.
  private readonly eyeHeight = 1;

  // Reusable scratch vectors so we don't allocate per-frame.
  private readonly _camDir = new THREE.Vector3();
  private readonly _moveTarget = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _rocketWorldPos = new THREE.Vector3();

  // Landed rocket / repeat-flight interaction. This lives fully in
  // Marble/Spark surface space (near the scan origin), not mission space.
  private readonly rocketRoot = new THREE.Group();
  private readonly rocketPad = new THREE.Group();
  private rocketModel: THREE.Group | null = null;
  private rocketLoadId = 0;
  private rocketReady = false;
  private rocketLoading = false;
  private rocketDistance = Number.POSITIVE_INFINITY;
  private rocketInRange = false;
  private rocketHintVisible = false;
  private rocketBoarding = false;
  private rocketGlow = 0;
  private currentPlanetId: string | null = null;
  private readonly beaconLights: THREE.PointLight[] = [];
  private entryRevealElapsed = ENTRY_REVEAL_SEC;

  // Robotaxi state — see `RobotaxiState` / `RobotaxiPhase` above. The truck
  // has its own root group so we can show/hide and translate it
  // independently of the landed rocket. Camera handoff toggles between the
  // PointerLockControls walking camera and a chase camera attached to the
  // truck. The high-level `robotaxiState` is kept stable for the HUD; the
  // finer-grained `robotaxiPhase` drives the per-frame controller below.
  private readonly robotaxiRoot = new THREE.Group();
  private robotaxiModel: THREE.Group | null = null;
  private robotaxiLoadStarted = false;
  private robotaxiState: RobotaxiState = "idle";
  private robotaxiPhase: RobotaxiPhase = "idle";

  /** Where the player was standing when they summoned. Pickup + drop-off anchor. */
  private readonly _robotaxiPickupPos = new THREE.Vector3();
  /** Player's horizontal forward direction at summon time (unit length, y=0). */
  private readonly _robotaxiPlayerForward = new THREE.Vector3(0, 0, -1);
  /** Player's horizontal right direction at summon time (unit length, y=0). */
  private readonly _robotaxiPlayerRight = new THREE.Vector3(1, 0, 0);
  /** Curbside spot the truck stops at — used for both pickup and dropoff. */
  private readonly _robotaxiArrivalPos = new THREE.Vector3();
  /** Heading the truck ends at when it arrives (= player forward heading). */
  private robotaxiArrivalHeading = 0;
  /** Filled at summon time — where the truck first becomes visible. */
  private readonly _robotaxiSpawnPos = new THREE.Vector3();
  /** End point of the departure segment. */
  private readonly _robotaxiDepartEndPos = new THREE.Vector3();

  /**
   * Cubic-Hermite control points for the active drive segment. p0..p1 with
   * t0/t1 are the start/end positions and tangents; the segment is
   * resampled every frame so heading rolls smoothly through the curve.
   */
  private readonly _robotaxiPathP0 = new THREE.Vector3();
  private readonly _robotaxiPathP1 = new THREE.Vector3();
  private readonly _robotaxiPathT0 = new THREE.Vector3();
  private readonly _robotaxiPathT1 = new THREE.Vector3();
  /** Approximate arc length of the active Hermite segment (m). */
  private robotaxiPathLength = 1;
  /** 0..1 along the active segment. */
  private robotaxiPathProgress = 0;
  /** Tour timer in seconds; 0..ROBOTAXI_TOUR_DURATION_SEC. */
  private robotaxiTourElapsed = 0;
  /** Tour-loop phase 0..1 — wraps continuously while cruising. */
  private robotaxiTourPhase = 0;
  /** Counts down boarding/dropoff pauses. */
  private robotaxiPhaseTimer = 0;

  /** Forward speed (m/s). Approaches `robotaxiTargetSpeed` each frame. */
  private robotaxiSpeed = 0;
  /** Commanded speed (m/s) — set by the per-phase target speed logic. */
  private robotaxiTargetSpeed = 0;
  /** Heading (rad). 0 = moving down -Z, +π/2 = +X. */
  private robotaxiHeading = 0;
  /** Smoothed steering input in [-1, 1], used for body roll only. */
  private robotaxiSteerInput = 0;
  /** Smoothed throttle/brake input in [-1, 1], used for body pitch only. */
  private robotaxiAccelInput = 0;

  private robotaxiModelBaseY = 0;
  private robotaxiCameraHandoff = 0;
  /**
   * 0..1 fade-in level for the truck on arrival, and 1..0 fade-out on
   * departure. Avoids the truck popping into existence at the spawn radius.
   * Actual material opacity is driven from this each frame in
   * applyRobotaxiSpawnFade.
   */
  private robotaxiSpawnFade = 1;
  private robotaxiSpawnFadeTarget = 1;

  /**
   * Rapier physics for the robotaxi. Lazy-initialised on first summon
   * because the WASM payload is ~2 MB and we don't want to pay for it
   * on planets that never spawn the truck. While `physicsLoading` is
   * pending, motion phases hold the truck offscreen and invisible until
   * physics resolves — same fallback shape as the GLB load.
   */
  private physics: RobotaxiPhysics | null = null;
  private physicsLoading: Promise<void> | null = null;
  /** Cached scratch quaternion to avoid per-frame allocations. */
  private readonly _physicsQuat = new THREE.Quaternion();
  private rideCameraReady = false;
  private rideCameraYaw = 0;
  private rideLookYawOffset = 0;
  private rideLookPitchOffset = 0;
  private readonly _rideCameraPos = new THREE.Vector3();
  private readonly _rideLookAt = new THREE.Vector3();
  /** Last truck world position; needed for derivative-based heading. */
  private readonly _robotaxiPrevPos = new THREE.Vector3();
  private readonly robotaxiTrackGroup = new THREE.Group();
  // Reusable scratch for robotaxi math.
  private readonly _taxiScratchA = new THREE.Vector3();
  private readonly _taxiScratchB = new THREE.Vector3();
  private readonly _taxiScratchC = new THREE.Vector3();
  private readonly _taxiScratchD = new THREE.Vector3();
  private readonly _taxiScratchE = new THREE.Vector3();
  private readonly _taxiScratchEuler = new THREE.Euler();
  /**
   * Persistent ground plane shown beneath the rocket + cybertruck so they
   * actually look like they're resting on terrain rather than levitating
   * over the cosmic void of an SPZ that doesn't ship with a floor.
   * Always built; visibility + tint update per-planet in
   * `applyGroundFloorForPlanet`.
   */
  private readonly _groundFloor: THREE.Mesh = new THREE.Mesh(
    new THREE.CircleGeometry(360, 160),
    new THREE.MeshStandardMaterial({
      color: 0x6a4a32,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );

  constructor(spark: SparkRenderer, canvas: HTMLCanvasElement) {
    this.spark = spark;
    this.canvas = canvas;

    // Match Marble's official world viewer (marble.worldlabs.ai): a 75° FOV
    // camera at (0, eyeHeight, 0) looking down -Z toward an orbit target at
    // (0, eyeHeight, -10). Marble's near/far defaults work out to roughly
    // the same as Spark's reference viewer (0.01 near, 1000 far), so we
    // keep those.
    this.camera = new THREE.PerspectiveCamera(
      this.normalFov,
      window.innerWidth / window.innerHeight,
      0.01,
      1000,
    );
    this.camera.position.set(0, this.eyeHeight, 0);
    this.scene.add(this.camera);

    // Spark is added on enter() / removed on exit() because the same
    // SparkRenderer is shared with FlightScene (cockpit splat) and only one
    // scene can own it at a time.

    // Marble worlds bake their own lighting and atmospheric haze into the
    // splat colours, but Three.js lights are still needed for the landed GLB
    // rocket. Spark splat colours are baked, so these low-intensity lights
    // do not wash the WorldLabs scene.
    this.scene.add(new THREE.HemisphereLight(0xb9eaff, 0x1a120d, 0.58));
    const rocketKey = new THREE.DirectionalLight(0xffe3bd, 1.9);
    rocketKey.position.set(-4, 7, 5);
    this.scene.add(rocketKey);
    const rocketRim = new THREE.DirectionalLight(0x7de9ff, 1.35);
    rocketRim.position.set(5, 3.5, -5);
    this.scene.add(rocketRim);

    // Ground floor — always present, tinted per-planet in
    // `applyGroundFloorForPlanet`. Sits at y=0 facing up, slightly below
    // ground so z-fighting with the splat splats doesn't sparkle. The
    // generated SPZ worlds we ship don't include a true floor, so this
    // catches the rocket + cybertruck against a believable surface.
    this._groundFloor.name = "surface.groundFloor";
    this._groundFloor.rotation.x = -Math.PI / 2;
    this._groundFloor.position.y = SURFACE_FLOOR_Y;
    this._groundFloor.receiveShadow = true;
    this.scene.add(this._groundFloor);

    this.robotaxiTrackGroup.name = "surface.robotaxi.tracks";
    this.robotaxiTrackGroup.visible = false;
    this.scene.add(this.robotaxiTrackGroup);

    this.buildLandedRocketSite();
    this.scene.add(this.rocketRoot);

    // Robotaxi container — kept hidden until the player summons one. The
    // model is loaded lazily on first summon so non-Mars landings don't
    // pay the network cost.
    this.robotaxiRoot.name = "surface.robotaxi";
    this.robotaxiRoot.visible = false;
    this.robotaxiRoot.position.y = ROBOTAXI_GROUND_Y;
    this.scene.add(this.robotaxiRoot);

    this.controls = new PointerLockControls(this.camera, canvas);
    // Match the look feel of the reference character controller.
    this.controls.pointerSpeed = 0.7;

    this.controls.addEventListener("lock", () => this.emitLock(true));
    this.controls.addEventListener("unlock", () => this.emitLock(false));

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
  }

  enter(): void {
    if (this.spark.parent !== this.scene) this.scene.add(this.spark);
  }

  exit(): void {
    if (this.controls.isLocked) {
      this.controls.unlock();
    }
    this.cancelBoarding();
    this.resetMovement();
    if (this.spark.parent === this.scene) {
      this.scene.remove(this.spark);
    }
  }

  /** Load the planet's splat. Re-callable for new destinations. */
  async loadPlanet(planet: Planet): Promise<void> {
    this._status = "loading";
    this._progress = 0;
    this._splatUrl = planet.splatUrl;
    this._lastError = null;
    this.currentPlanetId = planet.id;
    this.cancelBoarding();
    this.resetMovement();
    this.resetRocketState();
    // Cancel any in-progress robotaxi (e.g. player launches from
    // surface mid-tour) so the new planet starts clean.
    this.robotaxiState = "idle";
    this.robotaxiPhase = "idle";
    this.robotaxiTourElapsed = 0;
    this.robotaxiTourPhase = 0;
    this.robotaxiPathProgress = 0;
    this.robotaxiPhaseTimer = 0;
    this.robotaxiSpeed = 0;
    this.robotaxiTargetSpeed = 0;
    this.robotaxiSteerInput = 0;
    this.robotaxiAccelInput = 0;
    this.robotaxiCameraHandoff = 0;
    this.robotaxiSpawnFade = 1;
    this.robotaxiSpawnFadeTarget = 1;
    this.rideCameraReady = false;
    this.rideLookYawOffset = 0;
    this.rideLookPitchOffset = 0;
    this.robotaxiRoot.visible = false;
    this.robotaxiRoot.position.y = ROBOTAXI_GROUND_Y;
    this.clearRobotaxiTracks();
    this.entryRevealElapsed = 0;
    this.applyGroundFloorForPlanet(planet);
    void this.loadRocketForSurface(++this.rocketLoadId);

    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }
    this.clearFallbackSurface();

    // Reset the camera onto the scan origin and zero out any leftover motion.
    this.resetCameraPose(planet);
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;

    // If the planet's splat still points at the Spark public sample
    // (e.g. butterfly.spz from `npm run worlds:mock`), don't render it —
    // drop in a planet-themed procedural ground + starfield instead so the
    // player doesn't touch down inside a butterfly.
    if (isMockSplatUrl(planet.splatUrl)) {
      console.log(
        "[SurfaceScene] planet uses mock splat URL; using procedural surface",
        planet.id,
        planet.splatUrl,
      );
      this.buildFallbackSurface(planet);
      this.applyGroundFloorForPlanet(planet, true);
      this._groundFloor.visible = false;
      this._progress = 1;
      this._status = "ready";
      return;
    }

    console.log("[SurfaceScene] loading splat", planet.id, planet.splatUrl);
    try {
      const splat = new SplatMesh({
        url: planet.splatUrl,
        onProgress: (e: ProgressEvent) => {
          if (e.total > 0) {
            this._progress = Math.min(0.99, e.loaded / e.total);
          }
        },
      });
      // Canonical "right-side-up" form used by Spark's official viewer
      // (examples/viewer/index.html). Quaternion (1, 0, 0, 0) is a 180°
      // rotation around X — Marble splats are exported Y-down, so this
      // flips them upright.
      splat.quaternion.set(1, 0, 0, 0);
      splat.position.set(0, 0, 0);
      splat.scale.setScalar(1.0);
      this.scene.add(splat);
      this.splat = splat;

      await splat.initialized;
      console.log(
        "[SurfaceScene] splat initialized",
        planet.id,
        "splatCount:",
        splat.numSplats,
      );

      // Marble's viewer never reorients the camera based on splat geometry —
      // it simply spawns at the scan origin looking down -Z. We mirror that
      // behaviour exactly (see resetCameraPose); calling lookAt against a
      // bbox centroid here was what produced the off-axis "weird" pose vs.
      // the marble.worldlabs.ai preview.

      this._progress = 1;
      this._status = "ready";
    } catch (err) {
      console.error("[SurfaceScene] failed to load splat", err);
      this._status = "error";
      this._lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  update(delta: number, _elapsed: number): void {
    this.updateRocketInteraction(delta, _elapsed);
    this.entryRevealElapsed = Math.min(
      ENTRY_REVEAL_SEC,
      this.entryRevealElapsed + delta,
    );

    // Robotaxi tick — runs every frame so the truck animates whether
    // the player is walking or already riding. While the player is
    // riding the camera is owned by `updateRobotaxi`, which short-
    // circuits the walking-controller branch below by holding pointer
    // lock disabled and the move flags cleared.
    this.updateRobotaxi(delta, _elapsed);

    // Lerp factor based on `velocityXZSmoothing * accelerationTimeGrounded`.
    // The exponent 0.116 is what the reference controller uses to make the
    // response identical regardless of frame rate.
    const lerpFactor =
      1 -
      Math.pow(
        this.velocityXZSmoothing * this.accelerationTimeGrounded,
        0.116,
      );

    // Skip walking integration while riding — the robotaxi update has
    // already placed the camera and we don't want WASD bleed.
    if (this.robotaxiState === "touring" || this.robotaxiCameraHandoff > 0) {
      this.horizontalVelocity.set(0, 0, 0);
      this.verticalVelocity = 0;
      return;
    }

    if (!this.controls.isLocked) {
      // Smoothly decelerate to zero when not actively driving — no sudden snap.
      this.horizontalVelocity.lerp(this._moveTarget.set(0, 0, 0), lerpFactor);
      this.verticalVelocity = THREE.MathUtils.lerp(this.verticalVelocity, 0, lerpFactor);
    } else {
      // Build a unit input vector in camera-yaw space.
      // (front: +z when forward, side: +x when left, then rotated by yaw.)
      const fz = Number(this.moveBackward) - Number(this.moveForward);
      const fx = Number(this.moveLeft) - Number(this.moveRight);
      const fy = Number(this.moveUp) - Number(this.moveDown);

      const speed = this.walkSpeed * (this.sprint ? this.sprintMul : 1);

      this._moveTarget.set(fx, 0, fz);
      if (this._moveTarget.lengthSq() > 0) this._moveTarget.normalize();
      this._moveTarget.multiplyScalar(speed);

      this.camera.getWorldDirection(this._camDir);
      const cameraYaw = Math.atan2(this._camDir.x, this._camDir.z);
      this._moveTarget.applyAxisAngle(this._up, cameraYaw).multiplyScalar(-1);

      this.horizontalVelocity.lerp(this._moveTarget, lerpFactor);

      const targetVerticalVelocity = fy * this.verticalSpeed;
      this.verticalVelocity = THREE.MathUtils.lerp(
        this.verticalVelocity,
        targetVerticalVelocity,
        lerpFactor,
      );
    }

    // Snap to zero below threshold to avoid endless tiny drift.
    if (Math.abs(this.horizontalVelocity.x) < this.velocityMin) this.horizontalVelocity.x = 0;
    if (Math.abs(this.horizontalVelocity.z) < this.velocityMin) this.horizontalVelocity.z = 0;
    if (Math.abs(this.verticalVelocity) < this.velocityMin) this.verticalVelocity = 0;

    // Apply translation in world space directly on the camera.
    this.camera.position.x += this.horizontalVelocity.x * delta;
    this.camera.position.z += this.horizontalVelocity.z * delta;
    this.camera.position.y += this.verticalVelocity * delta;

    // FOV ramp: lerp toward sprintFov when sprinting + moving.
    const horizontalSpeed = Math.hypot(this.horizontalVelocity.x, this.horizontalVelocity.z);
    const targetFov = this.sprint && horizontalSpeed > 0.5 ? this.sprintFov : this.normalFov;
    const fovT = Math.min(1, delta * 8);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, fovT);
      this.camera.updateProjectionMatrix();
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("pointerdown", this.onCanvasPointerDown);
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
    }
    this.clearFallbackSurface();
    this.clearRocketModel();
    this.scene.remove(this.rocketRoot);
    if (this.robotaxiModel) {
      disposeObjectTree(this.robotaxiModel);
      this.robotaxiModel = null;
    }
    if (this.physics) {
      this.physics.dispose();
      this.physics = null;
    }
    this.physicsLoading = null;
    this.scene.remove(this.robotaxiRoot);
    this.clearRobotaxiTracks();
    this.scene.remove(this.robotaxiTrackGroup);
    this.scene.remove(this._groundFloor);
    this._groundFloor.geometry.dispose();
    (this._groundFloor.material as THREE.Material).dispose();
    this.rocketPad.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
  }

  /* Status surfacing */
  get status(): SurfaceStatus {
    return this._status;
  }
  get progress(): number {
    return this._progress;
  }
  get isLocked(): boolean {
    return this.controls.isLocked;
  }
  getEntryRevealProgress(): number {
    return Math.min(1, this.entryRevealElapsed / ENTRY_REVEAL_SEC);
  }

  getRobotaxiSnapshot(): SurfaceRobotaxiSnapshot {
    const available =
      this.robotaxiState === "idle" &&
      this._status === "ready" &&
      ROBOTAXI_PLANETS.has(this.currentPlanetId ?? "");
    let truckDistance: number | null = null;
    if (this.robotaxiState !== "idle" && this.robotaxiModel) {
      const truckPos = this._taxiScratchA.setFromMatrixPosition(
        this.robotaxiRoot.matrixWorld,
      );
      truckDistance = this.camera.position.distanceTo(truckPos);
    }
    // Tour progress visible to the HUD: during cruising it's the timer;
    // during the return drive we lock it at 100% so the progress bar
    // doesn't visually slide backwards.
    const tourProgress =
      this.robotaxiPhase === "cruising"
        ? Math.min(1, this.robotaxiTourElapsed / ROBOTAXI_TOUR_DURATION_SEC)
        : this.robotaxiPhase === "returning"
          ? 1
          : 0;
    return {
      available,
      state: this.robotaxiState,
      truckDistance,
      tourProgress,
    };
  }

  /**
   * Summon the robotaxi. No-op if it's already active or if the current
   * planet doesn't support robotaxi (Mars only for now). Returns true if
   * the summon actually started so the HUD can play its click cue.
   *
   * The arrival choreography is anchored to the player's facing direction
   * at this moment: the truck pulls up curbside a few meters in front of
   * the player, parallel to where they were looking, so when the camera
   * hands off into the cab the rider is already facing forward.
   */
  requestRobotaxi(): boolean {
    if (this.robotaxiState !== "idle") return false;
    if (!ROBOTAXI_PLANETS.has(this.currentPlanetId ?? "")) return false;
    if (this._status !== "ready") return false;

    // Lazy-load the model the first time. The summoning state holds until
    // the GLB resolves; if it's already cached this returns fast.
    if (!this.robotaxiModel && !this.robotaxiLoadStarted) {
      void this.loadRobotaxiModel();
    }

    // Pickup spot = where the camera is right now (player position).
    this._robotaxiPickupPos.copy(this.camera.position);
    this._robotaxiPickupPos.y = ROBOTAXI_GROUND_Y;

    // Capture the player's horizontal facing direction. `getWorldDirection`
    // returns the camera's -Z axis in world space, which is exactly the
    // direction the player is looking. We zero the Y component so the
    // truck stays on the ground plane no matter how the player tilts.
    this.camera.getWorldDirection(this._taxiScratchA);
    this._taxiScratchA.y = 0;
    if (this._taxiScratchA.lengthSq() < 1e-6) {
      this._taxiScratchA.set(0, 0, -1);
    }
    this._taxiScratchA.normalize();
    this._robotaxiPlayerForward.copy(this._taxiScratchA);
    // right = forward × up. With THREE's right-handed coords this yields a
    // proper right-hand-side vector regardless of yaw.
    this._robotaxiPlayerRight
      .copy(this._robotaxiPlayerForward)
      .cross(this._up)
      .normalize();

    // Curbside arrival pose: a few meters in front of the player and a
    // step to the right (pick whichever side gives a believable approach
    // arc — for now always the right, matching most real-world taxi norms).
    this._robotaxiArrivalPos.set(
      this._robotaxiPickupPos.x
        + this._robotaxiPlayerForward.x * ROBOTAXI_PICKUP_FORWARD
        + this._robotaxiPlayerRight.x * ROBOTAXI_PICKUP_SIDE,
      ROBOTAXI_GROUND_Y,
      this._robotaxiPickupPos.z
        + this._robotaxiPlayerForward.z * ROBOTAXI_PICKUP_FORWARD
        + this._robotaxiPlayerRight.z * ROBOTAXI_PICKUP_SIDE,
    );
    // Truck nose ends up pointing the same way as the player.
    this.robotaxiArrivalHeading = Math.atan2(
      this._robotaxiPlayerForward.x,
      -this._robotaxiPlayerForward.z,
    );

    // Spawn ~20 m out, biased mostly forward + a small lateral offset so
    // the arrival Hermite curve has room to bend gracefully into the
    // curbside pose without crabbing in sideways. The lateral magnitude
    // is scaled to ~30% of the spawn distance — at 20 m that puts the
    // truck about 6 m off the player's line-of-sight, ~17° off-axis,
    // which reads as a natural slight-arc approach.
    const tilt = (Math.random() - 0.5) * 0.5;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const spawnDirX =
      this._robotaxiPlayerForward.x * cosT - this._robotaxiPlayerForward.z * sinT;
    const spawnDirZ =
      this._robotaxiPlayerForward.x * sinT + this._robotaxiPlayerForward.z * cosT;
    const sideBias = Math.random() < 0.5 ? 1 : -1;
    const lateralOffset = ROBOTAXI_SPAWN_DISTANCE * 0.3;
    this._robotaxiSpawnPos.set(
      this._robotaxiPickupPos.x
        + spawnDirX * ROBOTAXI_SPAWN_DISTANCE
        + this._robotaxiPlayerRight.x * sideBias * lateralOffset,
      ROBOTAXI_GROUND_Y,
      this._robotaxiPickupPos.z
        + spawnDirZ * ROBOTAXI_SPAWN_DISTANCE
        + this._robotaxiPlayerRight.z * sideBias * lateralOffset,
    );

    this.robotaxiRoot.position.copy(this._robotaxiSpawnPos);
    this._robotaxiPrevPos.copy(this._robotaxiSpawnPos);
    this.robotaxiRoot.visible = Boolean(this.robotaxiModel);
    this.robotaxiState = "summoning";
    this.robotaxiPhase = "arriving";
    this.robotaxiTourElapsed = 0;
    this.robotaxiTourPhase = 0;
    this.robotaxiPathProgress = 0;
    this.robotaxiPhaseTimer = 0;
    this.robotaxiSpeed = 0;
    this.robotaxiTargetSpeed = ROBOTAXI_MAX_SPEED;
    this.robotaxiSteerInput = 0;
    this.robotaxiAccelInput = 0;
    this.robotaxiCameraHandoff = 0;
    // Start invisible; updateRobotaxi ramps the materials up over the next
    // ~0.9 s so the truck reads as "driving out of the haze toward you"
    // rather than spawning into existence at full opacity.
    this.robotaxiSpawnFade = 0;
    this.robotaxiSpawnFadeTarget = 1;
    this.applyRobotaxiSpawnFade(0);
    this.rideCameraReady = false;
    this.rideLookYawOffset = 0;
    this.rideLookPitchOffset = 0;
    this.buildRobotaxiTracks(this._robotaxiPickupPos);
    // Kick off Rapier load if this is the first summon, then teleport the
    // chassis to the spawn pose. If physics isn't ready yet, the per-frame
    // tick will hold the truck offscreen until it is.
    this.ensureRobotaxiPhysics();

    // Initial heading: aim from the spawn point toward the arrival pose so
    // the first few frames of motion have zero steering error and the truck
    // doesn't snap sideways before settling onto the Hermite curve.
    const aimDx = this._robotaxiArrivalPos.x - this._robotaxiSpawnPos.x;
    const aimDz = this._robotaxiArrivalPos.z - this._robotaxiSpawnPos.z;
    this.robotaxiHeading = Math.atan2(aimDx, -aimDz);
    this.rideCameraYaw = this.robotaxiHeading;
    this.robotaxiRoot.rotation.set(0, this.robotaxiHeading, 0);

    // Seed the arrival Hermite segment so the first updateRobotaxi tick
    // has a valid path to sample.
    this.beginArrivalPath();
    return true;
  }

  /**
   * End the tour early (or in response to the auto-timeout). Idempotent.
   * The truck routes back to the exact curbside arrival pose, stops, hands
   * the camera back to walk mode, then rolls forward out of the scene.
   *
   * If the model never finished loading we just snap back to idle so ESC
   * always works.
   */
  endRobotaxi(): void {
    if (this.robotaxiState === "idle") return;
    if (!this.robotaxiModel) {
      this.robotaxiState = "idle";
      this.robotaxiPhase = "idle";
      this.robotaxiRoot.visible = false;
      this.clearRobotaxiTracks();
      return;
    }
    // If we're already past the cruising tour, don't restart the return.
    if (
      this.robotaxiPhase === "returning"
      || this.robotaxiPhase === "dropoff"
      || this.robotaxiPhase === "departing"
    ) {
      return;
    }
    // If the truck never made it to the arrival pose (player hit R during
    // the inbound trip), short-circuit straight to dropoff so the camera
    // hand-back still feels controlled.
    if (this.robotaxiPhase === "arriving" || this.robotaxiPhase === "boarding") {
      this.robotaxiState = "ending";
      this.robotaxiPhase = "dropoff";
      this.robotaxiPhaseTimer = ROBOTAXI_DROPOFF_PAUSE_SEC;
      this.robotaxiTargetSpeed = 0;
      this.robotaxiCameraHandoff = ROBOTAXI_CAMERA_HANDOFF_SEC;
      if (this.controls.isLocked) this.controls.unlock();
      this.resetMovement();
      return;
    }
    // Normal case: tour was running, drive the truck home.
    this.robotaxiState = "touring"; // still riding while it heads back
    this.robotaxiPhase = "returning";
    this.beginReturnPath();
  }

  /**
   * Per-frame robotaxi driver. The truck advances along an authored path
   * (Hermite for arrival/return/departure, rounded-rectangle racetrack for
   * the cruising tour). Speed adapts to upcoming curvature so the truck
   * actually slows into corners and opens up on the straights, and heading
   * is damped behind the path tangent so cornering reads as a turn-in
   * rather than the truck snapping to face the next sample.
   */
  private updateRobotaxi(dt: number, elapsed: number): void {
    if (this.robotaxiState === "idle") return;
    if (!this.robotaxiModel) {
      // Model still loading — hold the truck offscreen invisibly until
      // it resolves; nothing else to update.
      return;
    }
    if (dt <= 0) return;
    this.robotaxiRoot.visible = true;

    // Fade-in (on spawn) / fade-out (on depart) ramp the truck materials
    // smoothly so it doesn't pop in or out of the world.
    if (this.robotaxiSpawnFade !== this.robotaxiSpawnFadeTarget) {
      const fadeRate = 1 / 0.9; // ~0.9 s ramp
      const next = this.robotaxiSpawnFade
        + Math.sign(this.robotaxiSpawnFadeTarget - this.robotaxiSpawnFade)
        * fadeRate * dt;
      this.robotaxiSpawnFade =
        this.robotaxiSpawnFadeTarget > this.robotaxiSpawnFade
          ? Math.min(this.robotaxiSpawnFadeTarget, next)
          : Math.max(this.robotaxiSpawnFadeTarget, next);
      this.applyRobotaxiSpawnFade(this.robotaxiSpawnFade);
    }

    // Physics not loaded yet — hold the truck invisible at its spawn pose
    // until the WASM resolves, then the per-phase tickers take over.
    if (!this.physics) {
      this.robotaxiRoot.position.copy(this._robotaxiSpawnPos);
      return;
    }

    switch (this.robotaxiPhase) {
      case "arriving": {
        this.tickPhysicsAlongHermite(dt, elapsed, /*stopAtEnd=*/ true);
        const dxArr = this.robotaxiRoot.position.x - this._robotaxiArrivalPos.x;
        const dzArr = this.robotaxiRoot.position.z - this._robotaxiArrivalPos.z;
        const distToArrival = Math.hypot(dxArr, dzArr);
        const reachedCurb =
          (this.robotaxiPathProgress >= 0.995 && distToArrival < 2.4 && this.robotaxiSpeed < 1.0)
          || (distToArrival < 1.2 && this.robotaxiSpeed < 0.85);
        if (reachedCurb) {
          // Stopped at the curb — settle the chassis to the exact arrival
          // pose so the boarding handoff has a clean reference, then begin
          // the boarding pause.
          this.physics.teleport(
            this._taxiScratchA.set(
              this._robotaxiArrivalPos.x,
              ROBOTAXI_GROUND_Y + ROBOTAXI_CHASSIS_TO_ROOT_Y,
              this._robotaxiArrivalPos.z,
            ),
            this.robotaxiArrivalHeading,
          );
          this.robotaxiSpeed = 0;
          this.robotaxiHeading = this.robotaxiArrivalHeading;
          this.robotaxiPhase = "boarding";
          this.robotaxiPhaseTimer = ROBOTAXI_BOARDING_PAUSE_SEC;
          if (this.controls.isLocked) this.controls.unlock();
          this.rideCameraReady = false;
          this.rideCameraYaw = this.robotaxiHeading;
          this.syncRootFromPhysics();
        }
        break;
      }

      case "boarding":
        this.tickPhysicsStopped(dt, elapsed);
        this.robotaxiPhaseTimer = Math.max(0, this.robotaxiPhaseTimer - dt);
        if (this.robotaxiPhaseTimer === 0) {
          this.robotaxiPhase = "cruising";
          this.robotaxiState = "touring";
          this.robotaxiTourElapsed = 0;
          this.robotaxiTourPhase = this.closestTourPhase(
            this.robotaxiRoot.position,
          );
        }
        break;

      case "cruising":
        this.tickPhysicsAlongTour(dt, elapsed);
        break;

      case "returning": {
        this.tickPhysicsAlongHermite(dt, elapsed, /*stopAtEnd=*/ true);
        const dxRet = this.robotaxiRoot.position.x - this._robotaxiArrivalPos.x;
        const dzRet = this.robotaxiRoot.position.z - this._robotaxiArrivalPos.z;
        const distToReturn = Math.hypot(dxRet, dzRet);
        const reachedDropoff =
          (this.robotaxiPathProgress >= 0.995 && distToReturn < 2.4 && this.robotaxiSpeed < 1.0)
          || (distToReturn < 1.2 && this.robotaxiSpeed < 0.85);
        if (reachedDropoff) {
          this.physics.teleport(
            this._taxiScratchA.set(
              this._robotaxiArrivalPos.x,
              ROBOTAXI_GROUND_Y + ROBOTAXI_CHASSIS_TO_ROOT_Y,
              this._robotaxiArrivalPos.z,
            ),
            this.robotaxiArrivalHeading,
          );
          this.robotaxiSpeed = 0;
          this.robotaxiHeading = this.robotaxiArrivalHeading;
          this.robotaxiPhase = "dropoff";
          this.robotaxiState = "ending";
          this.robotaxiPhaseTimer = ROBOTAXI_DROPOFF_PAUSE_SEC;
          this.robotaxiCameraHandoff = ROBOTAXI_CAMERA_HANDOFF_SEC;
          if (this.controls.isLocked) this.controls.unlock();
          this.resetMovement();
          this.syncRootFromPhysics();
        }
        break;
      }

      case "dropoff":
        this.tickPhysicsStopped(dt, elapsed);
        this.robotaxiPhaseTimer = Math.max(0, this.robotaxiPhaseTimer - dt);
        if (this.robotaxiPhaseTimer === 0) {
          this.robotaxiPhase = "departing";
          this.beginDeparturePath();
        }
        break;

      case "departing":
        this.tickPhysicsAlongHermite(dt, elapsed, /*stopAtEnd=*/ false);
        // Start the fade-out at the back third of the departure path.
        if (
          this.robotaxiPathProgress > 0.65
          && this.robotaxiSpawnFadeTarget !== 0
        ) {
          this.robotaxiSpawnFadeTarget = 0;
        }
        if (this.robotaxiPathProgress >= 1 && this.robotaxiSpawnFade <= 0.02) {
          this.robotaxiPhase = "idle";
          this.robotaxiState = "idle";
          this.robotaxiRoot.visible = false;
          this.robotaxiSpawnFade = 1;
          this.robotaxiSpawnFadeTarget = 1;
          this.applyRobotaxiSpawnFade(1);
          this.robotaxiTourElapsed = 0;
          this.robotaxiPathProgress = 0;
          this.robotaxiSpeed = 0;
          this.robotaxiTargetSpeed = 0;
          this.robotaxiSteerInput = 0;
          this.robotaxiAccelInput = 0;
          this.robotaxiCameraHandoff = 0;
          this.rideCameraReady = false;
          this.rideLookYawOffset = 0;
          this.rideLookPitchOffset = 0;
          this.clearRobotaxiTracks();
        }
        break;

      default:
        break;
    }

    // Camera ownership rules:
    //  * cruising / returning  → chase camera follows the truck
    //  * boarding              → chase camera (we're easing INTO the cab)
    //  * dropoff               → handoff camera (easing back to walk pose)
    //  * departing             → walking camera (player is back on foot)
    if (
      this.robotaxiPhase === "cruising"
      || this.robotaxiPhase === "returning"
      || this.robotaxiPhase === "boarding"
    ) {
      this.updateRobotaxiRideCamera(dt, elapsed);
    } else if (this.robotaxiPhase === "dropoff" || this.robotaxiCameraHandoff > 0) {
      this.updateRobotaxiCameraHandoff(dt);
    }

    this._robotaxiPrevPos.copy(this.robotaxiRoot.position);
  }

  /* -------- Physics-driven tickers -------- */

  /**
   * Pure-pursuit driver along the active Hermite segment. The path is the
   * AI driver's "intended trajectory"; the truck is a Rapier vehicle that
   * is steered + throttled toward a lookahead point on that path each
   * frame. The chassis pose comes back out of physics, so cornering
   * shows up as proper weight transfer + lateral slip rather than the
   * truck snapping to spline samples.
   */
  private tickPhysicsAlongHermite(
    dt: number,
    elapsed: number,
    stopAtEnd: boolean,
  ): void {
    if (!this.physics) return;
    const physics = this.physics;

    // Read truck state from physics.
    physics.readPosition(this._taxiScratchD);
    const heading = physics.heading();
    const currentSpeed = Math.max(0, physics.forwardSpeed());
    this.robotaxiSpeed = currentSpeed;
    this.robotaxiHeading = heading;

    // Keep progress tied to where the chassis actually is. If the tyres
    // drift wide, the lookahead target remains on the nearest forward path
    // point instead of marching away by speed alone.
    this.robotaxiPathProgress = this.closestHermiteProgress(
      this._taxiScratchD,
      this.robotaxiPathProgress,
    );

    // Lookahead target point on the path.
    const lookaheadDistance = this.robotaxiLookaheadDistance(
      currentSpeed,
      stopAtEnd ? this.robotaxiPathProgress : 0.5,
    );
    const lookaheadParam = Math.min(
      1,
      this.robotaxiPathProgress
        + lookaheadDistance / Math.max(0.5, this.robotaxiPathLength),
    );
    this.sampleHermite(
      this._robotaxiPathP0,
      this._robotaxiPathT0,
      this._robotaxiPathP1,
      this._robotaxiPathT1,
      lookaheadParam,
      this._taxiScratchC,
    );

    // Steering: pure pursuit toward the lookahead point in XZ plane.
    this.applyPursuitSteering(physics, heading, dt);

    // Speed control: shape target based on segment progress + curvature,
    // then PID-ish push toward it via engine force / brake.
    const cruiseWindow =
      smoothstep(0, 0.22, this.robotaxiPathProgress) *
      (stopAtEnd ? 1 - smoothstep(0.72, 1, this.robotaxiPathProgress) : 1);
    const curvatureFactor = this.estimateHermiteCurvature(
      this.robotaxiPathProgress,
    );
    const speedCeiling = THREE.MathUtils.lerp(
      ROBOTAXI_CORNER_SPEED,
      ROBOTAXI_MAX_SPEED,
      1 - curvatureFactor,
    );
    const baseTarget = stopAtEnd
      ? THREE.MathUtils.lerp(ROBOTAXI_APPROACH_SPEED, speedCeiling, cruiseWindow)
      : speedCeiling * cruiseWindow
        + ROBOTAXI_APPROACH_SPEED * (1 - cruiseWindow);
    const stopForce = stopAtEnd
      ? smoothstep(0.94, 1.0, this.robotaxiPathProgress)
      : 0;
    let desiredTargetSpeed = baseTarget * (1 - stopForce);
    if (stopAtEnd) {
      const distToEnd = Math.hypot(
        this._taxiScratchD.x - this._robotaxiPathP1.x,
        this._taxiScratchD.z - this._robotaxiPathP1.z,
      );
      const distanceTarget = THREE.MathUtils.clamp(
        (distToEnd - 0.7) * 0.85,
        0,
        ROBOTAXI_APPROACH_SPEED,
      );
      desiredTargetSpeed = Math.min(
        desiredTargetSpeed,
        distanceTarget,
      );
    }
    this.robotaxiTargetSpeed = damp(
      this.robotaxiTargetSpeed,
      desiredTargetSpeed,
      desiredTargetSpeed < this.robotaxiTargetSpeed ? 5.4 : 2.6,
      dt,
    );

    this.applySpeedControl(physics, currentSpeed, dt);

    // Soft lateral damping to suppress small drift when the path is straight.
    physics.applyLateralDamping(1.65, dt);

    physics.step(dt);
    this.recoverPhysicsChassisIfNeeded(physics, dt);
    this.syncRootFromPhysics();
    this.applyRobotaxiModelPose(dt, elapsed);
  }

  /**
   * Pure-pursuit driver along the closed racetrack tour. Same vehicle
   * dynamics as the Hermite tick, with target speed shaped by the loop's
   * local curvature and a gentle warm-up/cool-down envelope around the
   * tour timer.
   */
  private tickPhysicsAlongTour(dt: number, elapsed: number): void {
    if (!this.physics) return;
    const physics = this.physics;

    this.robotaxiTourElapsed += dt;
    if (this.robotaxiTourElapsed >= ROBOTAXI_TOUR_DURATION_SEC) {
      this.endRobotaxi();
      return;
    }

    physics.readPosition(this._taxiScratchD);
    const heading = physics.heading();
    const currentSpeed = Math.max(0, physics.forwardSpeed());
    this.robotaxiSpeed = currentSpeed;
    this.robotaxiHeading = heading;

    const nearestPhase = this.closestTourPhase(this._taxiScratchD);
    const phaseAdvance = (currentSpeed * dt) / ROBOTAXI_TOUR_PATH_LENGTH;
    this.robotaxiTourPhase = this.advanceLoopPhase(
      this.robotaxiTourPhase,
      nearestPhase,
      phaseAdvance,
    );

    // Lookahead point on the tour loop.
    const lookaheadDistance = this.robotaxiLookaheadDistance(currentSpeed, 0.5);
    const lookaheadPhase =
      (this.robotaxiTourPhase
        + lookaheadDistance / ROBOTAXI_TOUR_PATH_LENGTH)
      % 1;
    this.sampleRobotaxiTourPoint(lookaheadPhase, this._taxiScratchC);

    this.applyPursuitSteering(physics, heading, dt);

    // Target speed shaped by local curvature + tour envelope.
    const tourProgress = this.robotaxiTourElapsed / ROBOTAXI_TOUR_DURATION_SEC;
    const cruiseWindow =
      smoothstep(0, 0.10, tourProgress)
      * (1 - smoothstep(0.92, 1, tourProgress));
    const curvature = this.estimateTourCurvature(this.robotaxiTourPhase);
    const speedCeiling = THREE.MathUtils.lerp(
      ROBOTAXI_CORNER_SPEED,
      ROBOTAXI_MAX_SPEED,
      1 - curvature,
    );
    const desiredTargetSpeed = THREE.MathUtils.lerp(
      ROBOTAXI_APPROACH_SPEED,
      speedCeiling,
      cruiseWindow,
    );
    this.robotaxiTargetSpeed = damp(
      this.robotaxiTargetSpeed,
      desiredTargetSpeed,
      desiredTargetSpeed < this.robotaxiTargetSpeed ? 4.6 : 2.4,
      dt,
    );

    this.applySpeedControl(physics, currentSpeed, dt);
    physics.applyLateralDamping(1.45, dt);

    physics.step(dt);
    this.recoverPhysicsChassisIfNeeded(physics, dt);
    this.syncRootFromPhysics();
    this.applyRobotaxiModelPose(dt, elapsed);
  }

  /**
   * Boarding / dropoff pause: hold the truck still under physics. We
   * still step Rapier so suspension settles visually instead of going
   * rigid, but cut all engine force and clamp brakes.
   */
  private tickPhysicsStopped(dt: number, elapsed: number): void {
    if (!this.physics) return;
    const physics = this.physics;
    physics.setEngineForce(0);
    physics.setBrake(physics.maxBrake);
    physics.setSteering(0);
    // Damp out any residual velocity quickly.
    const linvel = physics.chassis.linvel();
    physics.chassis.setLinvel(
      { x: linvel.x * 0.5, y: linvel.y, z: linvel.z * 0.5 },
      true,
    );
    physics.step(dt);
    this.robotaxiSpeed = 0;
    this.robotaxiTargetSpeed = 0;
    this.syncRootFromPhysics();
    this.applyRobotaxiModelPose(dt, elapsed);
  }

  /**
   * Compute steering for pure pursuit toward `_taxiScratchC` (the
   * lookahead point set by the caller). Heading error → wheel angle,
   * clamped to the vehicle's maximum steer angle.
   */
  private applyPursuitSteering(
    physics: RobotaxiPhysics,
    heading: number,
    dt: number,
  ): void {
    physics.readPosition(this._taxiScratchD);
    const dx = this._taxiScratchC.x - this._taxiScratchD.x;
    const dz = this._taxiScratchC.z - this._taxiScratchD.z;
    const dlen = Math.max(1e-3, Math.hypot(dx, dz));
    const tdx = dx / dlen;
    const tdz = dz / dlen;
    // Truck forward at heading=0 is -Z, +X at heading=π/2.
    const fwdX = Math.sin(heading);
    const fwdZ = -Math.cos(heading);
    const cross = fwdX * tdz - fwdZ * tdx;
    const dotProd = fwdX * tdx + fwdZ * tdz;
    // Signed angle from forward to target direction.
    const headingError = Math.atan2(cross, dotProd);
    const steer = THREE.MathUtils.clamp(
      headingError * ROBOTAXI_STEER_GAIN,
      -physics.maxSteerAngle,
      physics.maxSteerAngle,
    );
    physics.setSteering(steer);
    // Update visible roll input proportional to steering.
    this.robotaxiSteerInput = damp(
      this.robotaxiSteerInput,
      steer / physics.maxSteerAngle,
      8,
      dt,
    );
  }

  /**
   * Convert the desired target speed into engine force or brake, given
   * current forward speed. Mirrors a real driver's foot: feathered
   * throttle when below target, brake (not reverse engine) when above.
   *
   * Engine force is in scene-forward units: positive = drive toward the
   * chassis nose. We never go negative
   * (no reverse) — overshoot is handled with brake instead.
   */
  private applySpeedControl(
    physics: RobotaxiPhysics,
    currentSpeed: number,
    dt: number,
  ): void {
    const speedError = this.robotaxiTargetSpeed - currentSpeed;
    if (speedError > 0.05) {
      const force = speedError * ROBOTAXI_ENGINE_GAIN;
      physics.setEngineForce(Math.min(physics.maxEngineForce, force));
      physics.setBrake(0);
      this.robotaxiAccelInput = damp(this.robotaxiAccelInput, 1, 6, dt);
    } else if (speedError < -0.05) {
      physics.setEngineForce(0);
      physics.setBrake(Math.min(physics.maxBrake, -speedError * ROBOTAXI_BRAKE_GAIN));
      this.robotaxiAccelInput = damp(this.robotaxiAccelInput, -1, 6, dt);
    } else {
      physics.setEngineForce(0);
      physics.setBrake(0);
      this.robotaxiAccelInput = damp(this.robotaxiAccelInput, 0, 4, dt);
    }
  }

  /**
   * Speed-aware pursuit lookahead. A real vehicle doesn't stare at a fixed
   * point on the ground: it looks farther down the road as speed rises, but
   * shortens the look when docking into the curbside stop.
   */
  private robotaxiLookaheadDistance(speed: number, endpointProgress: number): number {
    const speed01 = THREE.MathUtils.clamp(speed / ROBOTAXI_MAX_SPEED, 0, 1);
    const cruiseLookahead = THREE.MathUtils.lerp(
      ROBOTAXI_PURSUIT_LOOKAHEAD * 0.72,
      ROBOTAXI_PURSUIT_LOOKAHEAD * 1.55,
      speed01,
    );
    const docking = smoothstep(0.76, 0.98, endpointProgress);
    return THREE.MathUtils.lerp(cruiseLookahead, 3.2, docking);
  }

  /**
   * Let Rapier own normal vehicle motion. This is only a safety net for
   * pathological frames (falling through the floor, WASM hiccup, or a very
   * wide slide). Mild route drift gets a tiny impulse toward the lookahead;
   * severe height/route errors re-seat the chassis rather than exploding.
   */
  private recoverPhysicsChassisIfNeeded(physics: RobotaxiPhysics, dt: number): void {
    physics.readPosition(this._taxiScratchD);
    const dx = this._taxiScratchC.x - this._taxiScratchD.x;
    const dz = this._taxiScratchC.z - this._taxiScratchD.z;
    const dist = Math.max(1e-3, Math.hypot(dx, dz));
    const dirX = dx / dist;
    const dirZ = dz / dist;
    const targetY = ROBOTAXI_GROUND_Y + ROBOTAXI_CHASSIS_TO_ROOT_Y;
    const yError = targetY - this._taxiScratchD.y;

    if (Math.abs(yError) > 1.15 || dist > 16) {
      const safeHeading =
        dist > 0.2 ? Math.atan2(dirX, -dirZ) : this.robotaxiHeading;
      physics.chassis.setTranslation(
        {
          x: this._taxiScratchD.x + dirX * Math.min(dist, 4),
          y: targetY,
          z: this._taxiScratchD.z + dirZ * Math.min(dist, 4),
        },
        true,
      );
      const half = safeHeading * 0.5;
      physics.chassis.setRotation(
        { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
        true,
      );
      physics.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      physics.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }

    if (dist > 5.5) {
      const mass = physics.chassis.mass();
      const strength = THREE.MathUtils.clamp((dist - 5.5) * 0.18, 0, 0.85);
      physics.chassis.applyImpulse(
        {
          x: dirX * strength * mass * dt,
          y: 0,
          z: dirZ * strength * mass * dt,
        },
        true,
      );
    }
  }

  /** Copy chassis world transform onto the visible robotaxiRoot. */
  private syncRootFromPhysics(): void {
    if (!this.physics) return;
    this.physics.readPosition(this._taxiScratchA);
    this.physics.readQuaternion(this._physicsQuat);
    // Chassis Y is at the cuboid centre; subtract the rest offset so the
    // visible wheels touch the ground at static rest, and movement of
    // the chassis up/down (suspension travel) shows through naturally.
    this.robotaxiRoot.position.set(
      this._taxiScratchA.x,
      this._taxiScratchA.y - ROBOTAXI_CHASSIS_TO_ROOT_Y,
      this._taxiScratchA.z,
    );
    this.robotaxiRoot.quaternion.copy(this._physicsQuat);
  }

  /**
   * Lazy-initialise Rapier the first time the player summons. Subsequent
   * summons re-use the world and just teleport the chassis to the new
   * spawn pose. If WASM init fails (offline, ad blocker), the per-frame
   * tick keeps the truck invisible at spawn instead of crashing.
   */
  private ensureRobotaxiPhysics(): void {
    const groundY = ROBOTAXI_GROUND_Y;
    const heading = this.robotaxiHeading;
    const spawnX = this._robotaxiSpawnPos.x;
    const spawnZ = this._robotaxiSpawnPos.z;
    const teleport = (p: RobotaxiPhysics): void => {
      p.teleport(
        new THREE.Vector3(
          spawnX,
          groundY + ROBOTAXI_CHASSIS_TO_ROOT_Y,
          spawnZ,
        ),
        heading,
      );
    };

    if (this.physics) {
      teleport(this.physics);
      return;
    }
    if (this.physicsLoading) return;
    this.physicsLoading = createRobotaxiPhysics({ groundY })
      .then((p) => {
        this.physics = p;
        if (this.robotaxiPhase !== "idle") teleport(p);
      })
      .catch((err) => {
        console.warn("[SurfaceScene] Rapier vehicle physics failed", err);
      });
  }

  /**
   * Drive material opacity from the spawn-fade level. Caches each material's
   * original transparent flag and opacity the first time it touches the
   * material so we can restore them when the fade finishes. No-op if the
   * GLB hasn't loaded yet (called pre-load from requestRobotaxi).
   */
  private applyRobotaxiSpawnFade(level: number): void {
    if (!this.robotaxiModel) return;
    const eased = level <= 0
      ? 0
      : level >= 1
        ? 1
        : level * level * (3 - 2 * level); // smoothstep
    this.robotaxiModel.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats: THREE.Material[] = Array.isArray(mesh.material)
        ? (mesh.material as THREE.Material[])
        : mesh.material
          ? [mesh.material as THREE.Material]
          : [];
      mats.forEach((mat) => {
        const m = mat as THREE.Material & { opacity?: number };
        const ud = m.userData as {
          _origTransparent?: boolean;
          _origOpacity?: number;
          _origDepthWrite?: boolean;
        };
        if (ud._origOpacity === undefined) {
          ud._origTransparent = m.transparent;
          ud._origOpacity = m.opacity ?? 1;
          ud._origDepthWrite = m.depthWrite;
        }
        if (eased < 0.999) {
          m.transparent = true;
          m.opacity = (ud._origOpacity ?? 1) * eased;
          m.depthWrite = false;
        } else {
          m.transparent = ud._origTransparent ?? false;
          m.opacity = ud._origOpacity ?? 1;
          m.depthWrite = ud._origDepthWrite ?? true;
        }
        m.needsUpdate = true;
      });
    });
  }

  /**
   * Visual pose of the truck mesh inside the vehicle root: suspension
   * bounce, body roll into corners, body pitch on accel/brake. Magnitudes
   * are tuned to be felt but not seasickness-inducing.
   */
  private applyRobotaxiModelPose(dt: number, elapsed: number): void {
    if (!this.robotaxiModel) return;
    // Physics now owns pitch / roll / suspension via the chassis quaternion
    // and Y position. The visible model is a child of robotaxiRoot, which
    // already inherits those from the chassis — so we ONLY need to apply
    // the model's static yaw offset, plus a tiny high-frequency tyre
    // vibration that's too small to come through
    // a 60 Hz physics step.
    const speed01 = THREE.MathUtils.clamp(
      this.robotaxiSpeed / ROBOTAXI_MAX_SPEED,
      0,
      1,
    );
    const vibration =
      (0.004 * Math.sin(elapsed * 36.5) + 0.003 * noise1D(elapsed * 18.5, 3))
      * speed01;
    this.robotaxiModel.position.y = damp(
      this.robotaxiModel.position.y,
      this.robotaxiModelBaseY + vibration,
      18,
      dt,
    );
    this.robotaxiModel.rotation.set(0, ROBOTAXI_MODEL_YAW_OFFSET, 0);
  }

  private updateRobotaxiRideCamera(dt: number, elapsed: number): void {
    const root = this.robotaxiRoot;
    // Chase yaw lags the truck heading slightly so the camera doesn't
    // whip during the truck's own steering. A bit softer at speed.
    const speed01 = THREE.MathUtils.clamp(
      this.robotaxiSpeed / ROBOTAXI_MAX_SPEED,
      0,
      1,
    );
    this.rideCameraYaw = dampAngle(
      this.rideCameraYaw,
      this.robotaxiHeading,
      THREE.MathUtils.lerp(6.5, 4.5, speed01),
      dt,
    );
    const viewYaw = this.rideCameraYaw + this.rideLookYawOffset;
    const vibration =
      (0.018 * noise1D(elapsed * 6.2, 11) + 0.01 * Math.sin(elapsed * 15.7))
      * speed01;

    const offset = this._taxiScratchA.set(
      0,
      ROBOTAXI_RIDE_EYE_HEIGHT + vibration,
      ROBOTAXI_RIDE_EYE_OFFSET_Z + speed01 * 0.6,
    );
    offset.applyEuler(this._taxiScratchEuler.set(0, viewYaw, 0));
    const desiredCamera = this._taxiScratchC.copy(root.position).add(offset);

    const lookAhead = this._taxiScratchB.set(
      0,
      ROBOTAXI_RIDE_EYE_HEIGHT * 0.66
        + Math.sin(this.rideLookPitchOffset) * ROBOTAXI_RIDE_LOOKAHEAD,
      -ROBOTAXI_RIDE_LOOKAHEAD,
    );
    lookAhead.applyEuler(this._taxiScratchEuler.set(0, viewYaw, 0));
    const desiredLookAt = this._taxiScratchD.copy(root.position).add(lookAhead);

    if (!this.rideCameraReady) {
      this._rideCameraPos.copy(this.camera.position);
      this._rideLookAt.copy(desiredLookAt);
      this.rideCameraReady = true;
    }

    // Lazier position follow + slightly snappier look-target gives the
    // sense the camera is being pulled along after the truck rather than
    // bolted on rigidly to it.
    dampVec3(this._rideCameraPos, desiredCamera, 3.8, dt);
    dampVec3(this._rideLookAt, desiredLookAt, 7.0, dt);
    // Hard floor so the chase camera never sinks under splat terrain. The
    // splat scan origin sits with the player walking eye at y=1, so a 3.6
    // floor keeps us comfortably above the head-height plane even on a
    // bumpy splat with overhanging gaussians.
    if (this._rideCameraPos.y < ROBOTAXI_RIDE_MIN_CAMERA_Y) {
      this._rideCameraPos.y = ROBOTAXI_RIDE_MIN_CAMERA_Y;
    }
    if (this._rideLookAt.y < ROBOTAXI_RIDE_MIN_CAMERA_Y - 1.4) {
      this._rideLookAt.y = ROBOTAXI_RIDE_MIN_CAMERA_Y - 1.4;
    }
    this.camera.position.copy(this._rideCameraPos);
    this.camera.lookAt(this._rideLookAt);
  }

  private updateRobotaxiCameraHandoff(dt: number): void {
    this.robotaxiCameraHandoff = Math.max(0, this.robotaxiCameraHandoff - dt);
    const targetPos = this._taxiScratchA.copy(this._robotaxiPickupPos);
    targetPos.y = this.eyeHeight;
    // Look in the direction the player was originally facing — the truck
    // is parked a few meters in that direction, so the eye naturally lands
    // on the cybertruck during the hand-off.
    const targetLook = this._taxiScratchB.set(
      this._robotaxiPickupPos.x + this._robotaxiPlayerForward.x * 8,
      this.eyeHeight,
      this._robotaxiPickupPos.z + this._robotaxiPlayerForward.z * 8,
    );

    if (!this.rideCameraReady) {
      this._rideLookAt.copy(targetLook);
      this.rideCameraReady = true;
    }
    dampVec3(this.camera.position, targetPos, 5.2, dt);
    dampVec3(this._rideLookAt, targetLook, 5.8, dt);
    this.camera.lookAt(this._rideLookAt);

    if (this.robotaxiCameraHandoff === 0) {
      this.camera.position.copy(targetPos);
      this.camera.lookAt(targetLook);
      this.rideCameraReady = false;
    }
  }

  /* -------- Path samplers (Hermite + racetrack) -------- */

  /**
   * Cubic Hermite sample. p0/p1 are endpoints; t0/t1 are start/end
   * tangents (length controls "bulge" of the curve, direction controls
   * orientation at the endpoint). Writes position into `out` and the
   * unnormalised tangent into `tangentOut`.
   */
  private sampleHermite(
    p0: THREE.Vector3,
    t0: THREE.Vector3,
    p1: THREE.Vector3,
    t1: THREE.Vector3,
    s: number,
    out: THREE.Vector3,
    tangentOut?: THREE.Vector3,
  ): void {
    const t = THREE.MathUtils.clamp(s, 0, 1);
    const tt = t * t;
    const ttt = tt * t;
    const h00 = 2 * ttt - 3 * tt + 1;
    const h10 = ttt - 2 * tt + t;
    const h01 = -2 * ttt + 3 * tt;
    const h11 = ttt - tt;
    out.set(
      h00 * p0.x + h10 * t0.x + h01 * p1.x + h11 * t1.x,
      ROBOTAXI_GROUND_Y,
      h00 * p0.z + h10 * t0.z + h01 * p1.z + h11 * t1.z,
    );
    if (tangentOut) {
      // Derivative of cubic Hermite — gives the curve tangent.
      const dh00 = 6 * tt - 6 * t;
      const dh10 = 3 * tt - 4 * t + 1;
      const dh01 = -6 * tt + 6 * t;
      const dh11 = 3 * tt - 2 * t;
      tangentOut.set(
        dh00 * p0.x + dh10 * t0.x + dh01 * p1.x + dh11 * t1.x,
        0,
        dh00 * p0.z + dh10 * t0.z + dh01 * p1.z + dh11 * t1.z,
      );
    }
  }

  /** Numerical arc-length estimate of the active Hermite segment. */
  private approxHermiteLength(): number {
    const N = 18;
    const a = this._taxiScratchC;
    const b = this._taxiScratchD;
    this.sampleHermite(
      this._robotaxiPathP0,
      this._robotaxiPathT0,
      this._robotaxiPathP1,
      this._robotaxiPathT1,
      0,
      a,
    );
    let len = 0;
    for (let i = 1; i <= N; i++) {
      this.sampleHermite(
        this._robotaxiPathP0,
        this._robotaxiPathT0,
        this._robotaxiPathP1,
        this._robotaxiPathT1,
        i / N,
        b,
      );
      len += Math.hypot(b.x - a.x, b.z - a.z);
      a.copy(b);
    }
    return Math.max(0.5, len);
  }

  /**
   * Find the nearest forward point on the active Hermite path. Progress is
   * monotonic, but the search window is wide enough that a late physics load
   * or a tyre slide can still snap the driver back to the real route.
   */
  private closestHermiteProgress(pos: THREE.Vector3, previous: number): number {
    const window = 0.24;
    const minS = previous < 0.04 ? 0 : Math.max(0, previous - window * 0.35);
    const maxS = Math.min(1, Math.max(previous + window, minS + window));
    const coarseSteps = 28;
    let bestS = previous;
    let bestDistSq = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= coarseSteps; i++) {
      const s = THREE.MathUtils.lerp(minS, maxS, i / coarseSteps);
      this.sampleHermite(
        this._robotaxiPathP0,
        this._robotaxiPathT0,
        this._robotaxiPathP1,
        this._robotaxiPathT1,
        s,
        this._taxiScratchA,
      );
      const distSq =
        (this._taxiScratchA.x - pos.x) ** 2
        + (this._taxiScratchA.z - pos.z) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestS = s;
      }
    }

    const refineSpan = (maxS - minS) / coarseSteps;
    const refineMin = Math.max(0, bestS - refineSpan);
    const refineMax = Math.min(1, bestS + refineSpan);
    for (let i = 0; i <= 8; i++) {
      const s = THREE.MathUtils.lerp(refineMin, refineMax, i / 8);
      this.sampleHermite(
        this._robotaxiPathP0,
        this._robotaxiPathT0,
        this._robotaxiPathP1,
        this._robotaxiPathT1,
        s,
        this._taxiScratchA,
      );
      const distSq =
        (this._taxiScratchA.x - pos.x) ** 2
        + (this._taxiScratchA.z - pos.z) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestS = s;
      }
    }

    return THREE.MathUtils.clamp(Math.max(previous, bestS), 0, 1);
  }

  /**
   * Rough curvature heuristic in [0, 1]: sample the tangent at `s` and a
   * short distance later, return the angle between them, normalised so a
   * sharp arrival curve maps to ~1 and a near-straight stretch maps to ~0.
   */
  private estimateHermiteCurvature(s: number): number {
    this.sampleHermite(
      this._robotaxiPathP0,
      this._robotaxiPathT0,
      this._robotaxiPathP1,
      this._robotaxiPathT1,
      s,
      this._taxiScratchC,
      this._taxiScratchD,
    );
    const t1x = this._taxiScratchD.x;
    const t1z = this._taxiScratchD.z;
    const t1len = Math.max(1e-6, Math.hypot(t1x, t1z));
    const lookS = Math.min(1, s + 0.08);
    this.sampleHermite(
      this._robotaxiPathP0,
      this._robotaxiPathT0,
      this._robotaxiPathP1,
      this._robotaxiPathT1,
      lookS,
      this._taxiScratchC,
      this._taxiScratchE,
    );
    const t2x = this._taxiScratchE.x;
    const t2z = this._taxiScratchE.z;
    const t2len = Math.max(1e-6, Math.hypot(t2x, t2z));
    const dot = (t1x * t2x + t1z * t2z) / (t1len * t2len);
    const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    // ~30° lookahead delta ≈ pretty curvy. 60°+ counts as full curvature.
    return THREE.MathUtils.clamp(angle / 1.05, 0, 1);
  }

  /**
   * Rounded-rectangle (racetrack) tour path. Phase 0 starts at the
   * +X-axis edge of the front straight and walks clockwise around the
   * loop. The loop is composed of four straights and four quarter-arcs.
   */
  private sampleRobotaxiTourPoint(
    phase: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const p = phase - Math.floor(phase);
    const a = ROBOTAXI_TOUR_HALF_X;
    const b = ROBOTAXI_TOUR_HALF_Z;
    const r = ROBOTAXI_TOUR_CORNER_RADIUS;
    const straightX = Math.max(0, 2 * (a - r));   // length of long straight
    const straightZ = Math.max(0, 2 * (b - r));   // length of short straight
    const arc = (Math.PI / 2) * r;
    const perim = 2 * (straightX + straightZ) + 4 * arc;
    let s = p * perim;

    // Centre of the tour is the pickup point.
    const cx = this._robotaxiPickupPos.x;
    const cz = this._robotaxiPickupPos.z;
    let x = 0;
    let z = 0;

    // Segments, walked clockwise:
    //   1. Front straight (+X edge, z = +b, going -X) length straightX
    //   2. Top-left arc (-X, +Z corner)              length arc
    //   3. Left straight (z going -Z)                length straightZ
    //   4. Bottom-left arc                           length arc
    //   5. Back straight (going +X)                  length straightX
    //   6. Bottom-right arc                          length arc
    //   7. Right straight (going +Z)                 length straightZ
    //   8. Top-right arc                             length arc
    if (s < straightX) {
      x = (a - r) - s;
      z = b;
    } else if ((s -= straightX) < arc) {
      const t = s / arc;
      const ang = (Math.PI * 0.5) + t * (Math.PI * 0.5);
      x = -(a - r) + r * Math.cos(ang);
      z = (b - r) + r * Math.sin(ang);
    } else if ((s -= arc) < straightZ) {
      x = -a;
      z = (b - r) - s;
    } else if ((s -= straightZ) < arc) {
      const t = s / arc;
      const ang = Math.PI + t * (Math.PI * 0.5);
      x = -(a - r) + r * Math.cos(ang);
      z = -(b - r) + r * Math.sin(ang);
    } else if ((s -= arc) < straightX) {
      x = -(a - r) + s;
      z = -b;
    } else if ((s -= straightX) < arc) {
      const t = s / arc;
      const ang = (Math.PI * 1.5) + t * (Math.PI * 0.5);
      x = (a - r) + r * Math.cos(ang);
      z = -(b - r) + r * Math.sin(ang);
    } else if ((s -= arc) < straightZ) {
      x = a;
      z = -(b - r) + s;
    } else {
      // (s -= straightZ) goes into last arc
      s -= straightZ;
      const t = THREE.MathUtils.clamp(s / arc, 0, 1);
      const ang = 0 + t * (Math.PI * 0.5);
      x = (a - r) + r * Math.cos(ang);
      z = (b - r) + r * Math.sin(ang);
    }

    return out.set(cx + x, ROBOTAXI_GROUND_Y, cz + z);
  }

  /**
   * Estimate how curvy the track is right around `phase`. Used to slow
   * the truck through the rounded corners.
   */
  private estimateTourCurvature(phase: number): number {
    this.sampleRobotaxiTourPoint(phase, this._taxiScratchC);
    this.sampleRobotaxiTourPoint(phase + 0.012, this._taxiScratchD);
    this.sampleRobotaxiTourPoint(phase + 0.024, this._taxiScratchE);
    const ax = this._taxiScratchD.x - this._taxiScratchC.x;
    const az = this._taxiScratchD.z - this._taxiScratchC.z;
    const bx = this._taxiScratchE.x - this._taxiScratchD.x;
    const bz = this._taxiScratchE.z - this._taxiScratchD.z;
    const al = Math.max(1e-6, Math.hypot(ax, az));
    const bl = Math.max(1e-6, Math.hypot(bx, bz));
    const dot = (ax * bx + az * bz) / (al * bl);
    const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    // The sharpest curvature on a rounded rect is over a quarter-arc; a
    // 0.024-phase delta there subtends ~0.6 rad. Normalise to that.
    return THREE.MathUtils.clamp(angle / 0.55, 0, 1);
  }

  /**
   * Find the tour-loop phase closest to `pos`. Used at the
   * boarding→cruising transition so the truck enters the loop at the
   * nearest spot to the curbside arrival pose (no teleport).
   */
  private closestTourPhase(pos: THREE.Vector3): number {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    const probe = this._taxiScratchE;
    const N = 96;
    for (let i = 0; i < N; i++) {
      const phase = i / N;
      this.sampleRobotaxiTourPoint(phase, probe);
      const d = (probe.x - pos.x) ** 2 + (probe.z - pos.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = phase;
      }
    }
    return best;
  }

  /**
   * Blend closed-loop progress toward the nearest physical point while still
   * allowing forward motion through sparse samples and the 1→0 wrap.
   */
  private advanceLoopPhase(
    previous: number,
    nearest: number,
    phaseAdvance: number,
  ): number {
    const forwardDelta = THREE.MathUtils.euclideanModulo(
      nearest - previous,
      1,
    );
    const speedDelta = Math.max(phaseAdvance, 0);
    const correctedDelta = forwardDelta < 0.18
      ? Math.max(speedDelta, forwardDelta * 0.45)
      : speedDelta;
    return (previous + correctedDelta) % 1;
  }

  /* -------- Phase setup helpers -------- */

  /** Build the spawn → arrival Hermite segment. */
  private beginArrivalPath(): void {
    const start = this._robotaxiSpawnPos;
    const end = this._robotaxiArrivalPos;
    const dist = Math.max(1, Math.hypot(end.x - start.x, end.z - start.z));
    const mag = Math.max(10, dist * 0.6);
    // Start tangent: rough direction from spawn toward arrival, so the
    // first frames already point the truck the right way and the Hermite
    // shape is a graceful S rather than a hard loop.
    const dirX = end.x - start.x;
    const dirZ = end.z - start.z;
    const dirLen = Math.max(0.01, Math.hypot(dirX, dirZ));
    this._robotaxiPathP0.copy(start);
    this._robotaxiPathT0.set((dirX / dirLen) * mag, 0, (dirZ / dirLen) * mag);
    // End tangent: aligned with the player's forward, so the truck ends
    // up moving parallel to the curb at the arrival pose.
    this._robotaxiPathP1.copy(end);
    this._robotaxiPathT1.set(
      this._robotaxiPlayerForward.x * mag,
      0,
      this._robotaxiPlayerForward.z * mag,
    );
    this.robotaxiPathLength = this.approxHermiteLength();
    this.robotaxiPathProgress = 0;
  }

  /** Build the (truck's current pose) → arrival Hermite return segment. */
  private beginReturnPath(): void {
    const start = this._taxiScratchA.copy(this.robotaxiRoot.position);
    start.y = ROBOTAXI_GROUND_Y;
    const end = this._robotaxiArrivalPos;
    const dist = Math.max(1, Math.hypot(end.x - start.x, end.z - start.z));
    const mag = Math.max(12, dist * 0.55);
    const fwdX = Math.sin(this.robotaxiHeading);
    const fwdZ = -Math.cos(this.robotaxiHeading);
    this._robotaxiPathP0.copy(start);
    this._robotaxiPathT0.set(fwdX * mag, 0, fwdZ * mag);
    this._robotaxiPathP1.copy(end);
    this._robotaxiPathT1.set(
      this._robotaxiPlayerForward.x * mag,
      0,
      this._robotaxiPlayerForward.z * mag,
    );
    this.robotaxiPathLength = this.approxHermiteLength();
    this.robotaxiPathProgress = 0;
  }

  /** Build the post-dropoff departure: drive forward and exit the scene. */
  private beginDeparturePath(): void {
    const start = this._taxiScratchA.copy(this.robotaxiRoot.position);
    start.y = ROBOTAXI_GROUND_Y;
    const fwdX = Math.sin(this.robotaxiHeading);
    const fwdZ = -Math.cos(this.robotaxiHeading);
    this._robotaxiDepartEndPos.set(
      start.x + fwdX * ROBOTAXI_DEPART_DISTANCE,
      ROBOTAXI_GROUND_Y,
      start.z + fwdZ * ROBOTAXI_DEPART_DISTANCE,
    );
    const mag = ROBOTAXI_DEPART_DISTANCE * 0.4;
    this._robotaxiPathP0.copy(start);
    this._robotaxiPathT0.set(fwdX * mag, 0, fwdZ * mag);
    this._robotaxiPathP1.copy(this._robotaxiDepartEndPos);
    this._robotaxiPathT1.set(fwdX * mag, 0, fwdZ * mag);
    this.robotaxiPathLength = ROBOTAXI_DEPART_DISTANCE;
    this.robotaxiPathProgress = 0;
  }

  private async loadRobotaxiModel(): Promise<void> {
    this.robotaxiLoadStarted = true;
    try {
      const model = await loadNormalizedGltfModel(
        CYBERTRUCK_GLB_URL,
        ROBOTAXI_TARGET_LENGTH,
      );
      this.installRobotaxiModel(model, "surface.robotaxi.cybertruck");
    } catch (err) {
      console.warn(
        "[SurfaceScene] Cybertruck GLB failed; using procedural robotaxi fallback",
        err,
      );
      this.installRobotaxiModel(
        this.createFallbackCybertruckModel(),
        "surface.robotaxi.cybertruckFallback",
      );
    }
  }

  private installRobotaxiModel(model: THREE.Group, name: string): void {
    model.name = name;
    model.rotation.y = ROBOTAXI_MODEL_YAW_OFFSET;
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });

    // Ground the model against the root contact plane. Physics owns any
    // suspension lift; adding another visual clearance made the truck hover.
    const box = new THREE.Box3().setFromObject(model);
    if (Number.isFinite(box.min.y)) {
      model.position.y += -box.min.y;
    }
    this.robotaxiModelBaseY = model.position.y;
    this.robotaxiModel = model;
    this.robotaxiRoot.add(model);
    if (this.robotaxiState !== "idle") {
      this.robotaxiRoot.visible = true;
      this.applyRobotaxiModelPose(1 / 60, this.robotaxiTourElapsed);
      // If the player summoned before the GLB/fallback finished loading,
      // apply the current spawn-fade level immediately so the truck still
      // ramps in instead of appearing at full opacity mid-drive.
      this.applyRobotaxiSpawnFade(this.robotaxiSpawnFade);
    }
  }

  private createFallbackCybertruckModel(): THREE.Group {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x8d9699,
      roughness: 0.34,
      metalness: 0.78,
      emissive: 0x111417,
      emissiveIntensity: 0.08,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0b1720,
      roughness: 0.18,
      metalness: 0.25,
      transparent: true,
      opacity: 0.82,
      emissive: 0x062234,
      emissiveIntensity: 0.18,
    });
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x070707,
      roughness: 0.86,
      metalness: 0.08,
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xb8c1c4,
      roughness: 0.38,
      metalness: 0.68,
    });
    const headlightMat = new THREE.MeshBasicMaterial({
      color: 0xdff8ff,
      transparent: true,
      opacity: 0.86,
    });
    const tailMat = new THREE.MeshBasicMaterial({
      color: 0xff3e2f,
      transparent: true,
      opacity: 0.8,
    });

    const body = new THREE.Mesh(
      this.createCybertruckBodyGeometry(),
      bodyMat,
    );
    body.name = "fallbackCybertruck.body";
    group.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.72, 0.05, 1.8),
      glassMat,
    );
    cabin.name = "fallbackCybertruck.glassRoof";
    cabin.position.set(0, 1.12, 0.12);
    cabin.rotation.x = -0.34;
    group.add(cabin);

    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(1.65, 0.045, 0.72),
      glassMat,
    );
    windshield.name = "fallbackCybertruck.windshield";
    windshield.position.set(0, 0.97, 1.1);
    windshield.rotation.x = -0.72;
    group.add(windshield);

    const rearGlass = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.045, 0.82),
      glassMat,
    );
    rearGlass.name = "fallbackCybertruck.rearGlass";
    rearGlass.position.set(0, 0.94, -0.92);
    rearGlass.rotation.x = 0.58;
    group.add(rearGlass);

    const bumperGeom = new THREE.BoxGeometry(2.04, 0.16, 0.16);
    const frontBar = new THREE.Mesh(bumperGeom, headlightMat);
    frontBar.name = "fallbackCybertruck.frontLightBar";
    frontBar.position.set(0, 0.72, 2.36);
    group.add(frontBar);
    const rearBar = new THREE.Mesh(bumperGeom, tailMat);
    rearBar.name = "fallbackCybertruck.rearLightBar";
    rearBar.position.set(0, 0.66, -2.34);
    group.add(rearBar);

    const wheelGeom = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 32);
    wheelGeom.rotateZ(Math.PI / 2);
    const rimGeom = new THREE.CylinderGeometry(0.22, 0.22, 0.36, 24);
    rimGeom.rotateZ(Math.PI / 2);
    const wheelPositions: THREE.Vector3Tuple[] = [
      [-1.02, 0.43, 1.42],
      [1.02, 0.43, 1.42],
      [-1.02, 0.43, -1.42],
      [1.02, 0.43, -1.42],
    ];
    wheelPositions.forEach((pos, i) => {
      const wheel = new THREE.Mesh(wheelGeom, tireMat);
      wheel.name = `fallbackCybertruck.wheel.${i}`;
      wheel.position.set(...pos);
      group.add(wheel);
      const rim = new THREE.Mesh(rimGeom, rimMat);
      rim.name = `fallbackCybertruck.rim.${i}`;
      rim.position.set(...pos);
      group.add(rim);
    });

    const underglow = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.035, 3.6),
      new THREE.MeshBasicMaterial({
        color: 0x5fe9ff,
        transparent: true,
        opacity: 0.18,
      }),
    );
    underglow.name = "fallbackCybertruck.underglow";
    underglow.position.set(0, 0.18, 0);
    group.add(underglow);

    return group;
  }

  private createCybertruckBodyGeometry(): THREE.BufferGeometry {
    const hw = 1.05;
    const hz = 2.4;
    const vertices = new Float32Array([
      -hw, 0.38, -hz,   hw, 0.38, -hz,   hw, 0.38, hz,   -hw, 0.38, hz,
      -hw, 0.72, -hz,   hw, 0.72, -hz,   hw, 0.72, hz,   -hw, 0.72, hz,
      -0.86, 1.38, -0.3,   0.86, 1.38, -0.3,
    ]);
    const indices = [
      0, 2, 1, 0, 3, 2, // lower pan
      0, 1, 5, 0, 5, 4, // rear face
      2, 3, 7, 2, 7, 6, // front face
      0, 4, 7, 0, 7, 3, // left lower side
      1, 2, 6, 1, 6, 5, // right lower side
      4, 5, 9, 4, 9, 8, // rear roof slope
      5, 6, 9, // right hood slope
      6, 7, 8, 6, 8, 9, // windshield/hood plane
      7, 4, 8, // left hood slope
      4, 7, 6, 4, 6, 5, // belt plane under glass
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  getRocketInteraction(): SurfaceRocketInteractionSnapshot {
    return {
      ready: this.rocketReady,
      loading: this.rocketLoading,
      boarding: this.rocketBoarding,
      distance: this.rocketDistance,
      inRange: this.rocketInRange,
      hintVisible: this.rocketHintVisible,
      boardRange: ROCKET_BOARD_RANGE,
      hintRange: ROCKET_HINT_RANGE,
      currentPlanetId: this.currentPlanetId,
    };
  }

  requestBoarding(): boolean {
    if (!this.rocketReady || !this.rocketInRange) return false;
    this.rocketBoarding = true;
    if (this.controls.isLocked) this.controls.unlock();
    this.resetMovement();
    return true;
  }

  cancelBoarding(): void {
    this.rocketBoarding = false;
  }

  /** Snapshot used by the on-screen debug HUD. */
  getDebugSnapshot(): SurfaceDebugSnapshot {
    let bbox: THREE.Box3 | null = null;
    let splatCount: number | null = null;
    if (this.splat) {
      try {
        const b = this.splat.getBoundingBox?.(true);
        if (b && Number.isFinite(b.min.x) && !b.isEmpty()) bbox = b;
      } catch {
        bbox = null;
      }
      const splatAny = this.splat as unknown as {
        numSplats?: number;
        splats?: { numSplats?: number; lodSplats?: { numSplats?: number } };
      };
      splatCount =
        splatAny.numSplats ??
        splatAny.splats?.lodSplats?.numSplats ??
        splatAny.splats?.numSplats ??
        null;
    }
    return {
      status: this._status,
      progress: this._progress,
      isLocked: this.controls.isLocked,
      splatUrl: this._splatUrl,
      splatCount,
      splatPosition: this.splat ? this.splat.position.clone() : null,
      splatQuaternion: this.splat ? this.splat.quaternion.clone() : null,
      splatScale: this.splat ? this.splat.scale.clone() : null,
      bbox,
      lastError: this._lastError,
      splat: this.splat,
    };
  }

  /* Pointer lock plumbing for the HUD */

  requestPointerLock(): void {
    if (!this.controls.isLocked) {
      this.canvas.focus();
      this.controls.lock();
    }
  }

  onLockChange(cb: LockListener): void {
    this.lockListeners.push(cb);
  }

  private emitLock(locked: boolean): void {
    this.lockListeners.forEach((cb) => cb(locked));
  }

  /**
   * Receive the touchdown spawn pose from MissionScene. Kept on the public
   * API for compatibility with the existing handoff wiring, but it's a
   * no-op: the mission-space pose isn't a valid surface-space pose (see
   * the comment near the top of the class). The player always spawns at
   * the Marble scan origin so the splat renders correctly.
   */
  setSpawnPose(_pose: { position: THREE.Vector3; quaternion: THREE.Quaternion }): void {
    void _pose;
  }

  private resetCameraPose(_planet: Planet): void {
    // Marble's official viewer (marble.worldlabs.ai) settles the camera at
    // (0, 1, 0) looking at (0, 1, -10) once the splat has loaded. After our
    // OpenCV→OpenGL flip on the splat (quaternion 1, 0, 0, 0 — a 180°
    // rotation around X), this is exactly the framing the Marble preview
    // shows. Reproducing it byte-for-byte gives us the same hero view the
    // user saw when they generated the world.
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.quaternion.identity();
    this.camera.lookAt(0, this.eyeHeight, -10);
  }

  /**
   * Build a procedural planet-themed surface to stand in for a missing
   * Marble splat. It's deliberately modest — a large tinted ground disc,
   * a few scattered boulders, and a starfield sky — but it reads as "you
   * landed on X" rather than "you landed inside a butterfly".
   */
  /**
   * Tint the persistent ground floor to match the planet's theme. Uses
   * the planet's `theme.dark` colour and dials opacity down on bodies
   * whose splat already carries strong terrain (Luna's regolith reads
   * fine against a near-black floor; Mars wants a redder one). On
   * Earth-style worlds with their own ground we'd hide this, but right
   * now every body benefits from at least a faint disc to anchor the
   * GLBs.
   */
  private applyGroundFloorForPlanet(planet: Planet, mockFallback = false): void {
    const mat = this._groundFloor.material as THREE.MeshStandardMaterial;
    const dark = new THREE.Color(planet.theme.dark);
    const mid = new THREE.Color(planet.theme.mid);
    const light = new THREE.Color(planet.theme.light);
    mat.color = new THREE.Color(0xffffff);
    this.paintRadialGroundColors(
      this._groundFloor.geometry as THREE.BufferGeometry,
      mid.clone().lerp(light, planet.id === "mars" ? 0.18 : 0.1),
      dark.clone().lerp(mid, planet.id === "mars" ? 0.28 : 0.18),
      planet.id,
    );
    // Mars ('mars') wants a bolder rust; Luna ('luna') wants a soft
    // grey that fades into the splat's existing regolith. Other worlds
    // get a moderate opacity by default.
    mat.opacity =
      mockFallback
        ? 0.94
        : planet.id === "mars" ? 0.58 : planet.id === "luna" ? 0.48 : 0.68;
    mat.roughness = planet.id === "mars" ? 1 : 0.95;
    mat.metalness = 0;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    this._groundFloor.visible = true;
  }

  private paintRadialGroundColors(
    geometry: THREE.BufferGeometry,
    centerColor: THREE.Color,
    edgeColor: THREE.Color,
    seedKey: string,
  ): void {
    const pos = geometry.getAttribute("position");
    if (!pos) return;
    const colors = new Float32Array(pos.count * 3);
    const seed = hashString(seedKey) * 0.000001;
    const radius = 360;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const radial = Math.min(1, Math.hypot(x, y) / radius);
      const band =
        0.04 * Math.sin(x * 0.19 + seed)
        + 0.035 * Math.sin(y * 0.23 + seed * 2.1)
        + 0.025 * Math.sin((x + y) * 0.075 + seed * 3.7);
      const dust = THREE.MathUtils.clamp(radial + band, 0, 1);
      const c = centerColor.clone().lerp(edgeColor, dust);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.getAttribute("color").needsUpdate = true;
  }

  private buildRobotaxiTracks(center: THREE.Vector3): void {
    this.clearRobotaxiTracks();
    if (this.currentPlanetId !== "mars") return;

    const roadMat = new THREE.MeshBasicMaterial({
      color: 0x7b2d14,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trackMat = new THREE.LineBasicMaterial({
      color: 0x2b0d05,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0x5e2412,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // A soft drivable dust lane under the full tour loop. This makes the
    // robotaxi feel like it has a floor/road instead of floating over the
    // splat, but stays translucent enough to blend with real SPZ terrain.
    const laneGeom = new THREE.CircleGeometry(1, 32);
    for (let i = 0; i < 40; i++) {
      const phase = i / 40;
      const p = this.sampleRobotaxiTourPoint(phase, this._taxiScratchA).clone();
      const ahead = this.sampleRobotaxiTourPoint(
        (phase + 0.006) % 1,
        this._taxiScratchB,
      );
      const tx = ahead.x - p.x;
      const tz = ahead.z - p.z;
      const yaw = Math.atan2(tx, -tz);
      const lane = new THREE.Mesh(laneGeom, roadMat);
      lane.position.set(p.x, SURFACE_DECAL_Y - 0.006, p.z);
      lane.rotation.x = -Math.PI / 2;
      lane.rotation.z = -yaw;
      lane.scale.set(4.1, 1.45, 1);
      this.robotaxiTrackGroup.add(lane);
    }

    // Curbside pickup/dropoff patch where the truck comes to rest.
    const pad = new THREE.Mesh(new THREE.CircleGeometry(4.4, 56), roadMat);
    pad.position.set(this._robotaxiArrivalPos.x, SURFACE_DECAL_Y - 0.004, this._robotaxiArrivalPos.z);
    pad.rotation.x = -Math.PI / 2;
    pad.scale.set(1.35, 0.72, 1);
    this.robotaxiTrackGroup.add(pad);

    const pickupDust = new THREE.Mesh(new THREE.CircleGeometry(2.8, 48), dustMat);
    pickupDust.position.set(center.x, SURFACE_DECAL_Y - 0.002, center.z);
    pickupDust.rotation.x = -Math.PI / 2;
    pickupDust.scale.set(1.25, 0.5, 1);
    this.robotaxiTrackGroup.add(pickupDust);

    // Two wheel ruts offset to either side of the centerline along the
    // racetrack path. We trace the same rounded-rectangle the truck
    // drives so the tracks line up with where it actually goes.
    const N = 192;
    [-0.82, 0.82].forEach((wheelOffset) => {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < N; i++) {
        const phase = i / N;
        const aheadPhase = (phase + 0.004) % 1;
        const p = this.sampleRobotaxiTourPoint(phase, this._taxiScratchA).clone();
        const ahead = this.sampleRobotaxiTourPoint(aheadPhase, this._taxiScratchB);
        const tx = ahead.x - p.x;
        const tz = ahead.z - p.z;
        const tlen = Math.max(1e-4, Math.hypot(tx, tz));
        // perpendicular to the tangent, in the ground plane
        const sx = -tz / tlen;
        const sz = tx / tlen;
        points.push(
          new THREE.Vector3(
            p.x + sx * wheelOffset,
            SURFACE_DECAL_Y + 0.006,
            p.z + sz * wheelOffset,
          ),
        );
      }
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      this.robotaxiTrackGroup.add(new THREE.LineLoop(geom, trackMat));
    });

    // Dust streaks tangent-aligned along the loop.
    const dustGeom = new THREE.CircleGeometry(1, 24);
    for (let i = 0; i < 22; i++) {
      const phase = i / 22;
      const p = this.sampleRobotaxiTourPoint(phase, this._taxiScratchA).clone();
      const ahead = this.sampleRobotaxiTourPoint(
        (phase + 0.004) % 1,
        this._taxiScratchB,
      );
      const tx = ahead.x - p.x;
      const tz = ahead.z - p.z;
      const yaw = Math.atan2(tx, -tz);
      const dust = new THREE.Mesh(dustGeom, dustMat);
      dust.position.set(p.x, SURFACE_DECAL_Y, p.z);
      dust.rotation.x = -Math.PI / 2;
      const scale = 1.2 + 0.45 * Math.sin(i * 2.41);
      // For a CircleGeometry rotated -π/2 about X (now lying flat on the
      // ground), rotating about Z aligns it within the ground plane.
      dust.rotation.z = -yaw;
      dust.scale.set(scale * 1.7, scale * 0.46, 1);
      this.robotaxiTrackGroup.add(dust);
    }

    this.robotaxiTrackGroup.visible = true;
  }

  private clearRobotaxiTracks(): void {
    this.robotaxiTrackGroup.visible = false;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.robotaxiTrackGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh | THREE.Line;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((mat) => materials.add(mat));
      } else {
        if (material) materials.add(material);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.robotaxiTrackGroup.clear();
  }

  private buildFallbackSurface(planet: Planet): void {
    const group = new THREE.Group();
    group.name = `surface.fallback.${planet.id}`;

    const theme = planet.theme;
    const lightColor = new THREE.Color(theme.light);
    const midColor = new THREE.Color(theme.mid);
    const darkColor = new THREE.Color(theme.dark);

    // Ground: a large soft-tinted disc with a subtle radial gradient so
    // the horizon fades out rather than ending in a hard edge.
    const groundGeom = new THREE.CircleGeometry(420, 128);
    const groundColors = new Float32Array(groundGeom.attributes.position.count * 3);
    const pos = groundGeom.attributes.position;
    const nearTint = midColor.clone().lerp(lightColor, 0.25);
    const farTint = midColor.clone().lerp(darkColor, 0.55);
    const groundSeed = hashString(`${planet.id}:fallback-ground`) * 0.000001;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.min(1, Math.hypot(x, y) / 420);
      const jitter =
        0.94
        + 0.04 * Math.sin(x * 0.17 + groundSeed)
        + 0.025 * Math.sin(y * 0.31 + groundSeed * 1.9);
      const c = nearTint.clone().lerp(farTint, r).multiplyScalar(jitter);
      groundColors[i * 3 + 0] = c.r;
      groundColors[i * 3 + 1] = c.g;
      groundColors[i * 3 + 2] = c.b;
    }
    groundGeom.setAttribute("color", new THREE.BufferAttribute(groundColors, 3));
    const groundMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = SURFACE_FLOOR_Y;
    ground.receiveShadow = false;
    group.add(ground);

    // Scattered boulders — deterministic placement per-planet so repeat
    // visits look the same.
    const rng = mulberry32(hashString(planet.id));
    const rockMat = new THREE.MeshStandardMaterial({
      color: midColor.clone().multiplyScalar(0.85),
      roughness: 0.95,
      metalness: 0.03,
    });
    const rockGeom = new THREE.IcosahedronGeometry(1, 1);
    const rocks = new THREE.InstancedMesh(rockGeom, rockMat, 48);
    const rockMatrix = new THREE.Matrix4();
    const rockPos = new THREE.Vector3();
    const rockQuat = new THREE.Quaternion();
    const rockScale = new THREE.Vector3();
    for (let i = 0; i < rocks.count; i++) {
      // Spread rocks in a ring between 14 and 120 units so the spawn area
      // near the rocket pad stays clear.
      const a = rng() * Math.PI * 2;
      const radius = 14 + rng() * 106;
      rockPos.set(
        Math.cos(a) * radius,
        SURFACE_GROUND_Y - 0.22 + rng() * 0.32,
        Math.sin(a) * radius,
      );
      rockQuat.setFromEuler(
        new THREE.Euler(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6),
      );
      const s = 0.4 + rng() * 1.6;
      rockScale.set(s, 0.65 * s, s);
      rockMatrix.compose(rockPos, rockQuat, rockScale);
      rocks.setMatrixAt(i, rockMatrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    group.add(rocks);

    // Sky: a large starfield dome tinted by the planet's glow colour so
    // Europa reads icy-blue, Mars reads salmon, Titan reads amber, etc.
    const stars = createStarfield({ count: 1800, radius: 520, size: 1.4 });
    const starMat = stars.material as THREE.PointsMaterial;
    starMat.color = lightColor.clone().lerp(new THREE.Color(0xffffff), 0.4);
    group.add(stars);

    // Subtle sky dome so it doesn't read as pure black — uses the
    // planet's `dark` theme colour on the inside of a large back-faced
    // sphere.
    const domeMat = new THREE.MeshBasicMaterial({
      color: darkColor,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), domeMat);
    dome.position.y = 0;
    group.add(dome);

    this.scene.add(group);
    this.fallbackGroup = group;
  }

  private clearFallbackSurface(): void {
    if (!this.fallbackGroup) return;
    this.scene.remove(this.fallbackGroup);
    this.fallbackGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
    this.fallbackGroup = null;
  }

  private buildLandedRocketSite(): void {
    this.rocketRoot.name = "surface.landedRocket";
    this.rocketRoot.position.copy(ROCKET_LANDING_POSITION);
    this.rocketRoot.rotation.y = -0.32;
    this.rocketRoot.visible = false;

    const scorchMat = new THREE.MeshBasicMaterial({
      color: 0x050404,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(3.8, 80), scorchMat);
    scorch.name = "surface.landedRocket.scorch";
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.012;
    this.rocketPad.add(scorch);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4cd6ff,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.95, 4.15, 96), ringMat);
    ring.name = "surface.landedRocket.padRing";
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.rocketPad.add(ring);

    const strutMat = new THREE.MeshBasicMaterial({
      color: 0xffba20,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    const strutGeom = new THREE.BoxGeometry(0.08, 0.018, 7.6);
    for (let i = 0; i < 4; i++) {
      const strut = new THREE.Mesh(strutGeom, strutMat);
      strut.rotation.y = (Math.PI / 4) + (i * Math.PI) / 2;
      strut.position.y = 0.045;
      this.rocketPad.add(strut);
    }

    const coreGlow = new THREE.PointLight(0x5fe9ff, 1.3, 9, 1.8);
    coreGlow.position.set(0, 0.45, 0);
    this.beaconLights.push(coreGlow);
    this.rocketPad.add(coreGlow);

    const beaconGeom = new THREE.SphereGeometry(0.12, 16, 10);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0x7df9ff,
      transparent: true,
      opacity: 0.78,
    });
    const beaconPositions: THREE.Vector3Tuple[] = [
      [3.3, 0.18, 3.3],
      [-3.3, 0.18, 3.3],
      [3.3, 0.18, -3.3],
      [-3.3, 0.18, -3.3],
    ];
    beaconPositions.forEach((pos) => {
      const beacon = new THREE.Mesh(beaconGeom, beaconMat);
      beacon.position.set(...pos);
      this.rocketPad.add(beacon);
      const light = new THREE.PointLight(0x7df9ff, 0.65, 5.5, 1.7);
      light.position.set(...pos);
      this.beaconLights.push(light);
      this.rocketPad.add(light);
    });

    this.rocketRoot.add(this.rocketPad);
  }

  private resetRocketState(): void {
    this.rocketReady = false;
    this.rocketLoading = true;
    this.rocketDistance = Number.POSITIVE_INFINITY;
    this.rocketInRange = false;
    this.rocketHintVisible = false;
    this.rocketGlow = 0;
    this.rocketRoot.visible = false;
    this.clearRocketModel();
  }

  private async loadRocketForSurface(loadId: number): Promise<void> {
    try {
      const model = await loadNormalizedGltfModel(
        ARTEMIS_ROCKET_GLB_URL,
        ROCKET_TARGET_DIAMETER,
      );
      if (loadId !== this.rocketLoadId) {
        disposeObjectTree(model);
        return;
      }

      this.clearRocketModel();
      model.name = "surface.landedRocket.artemis";
      model.rotation.y = 0.18;
      const box = new THREE.Box3().setFromObject(model);
      if (Number.isFinite(box.min.y)) {
        model.position.y += -box.min.y + 0.04;
      }
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
      this.rocketModel = model;
      this.rocketRoot.add(model);
      this.rocketReady = true;
      this.rocketLoading = false;
      this.rocketRoot.visible = true;
    } catch (err) {
      if (loadId !== this.rocketLoadId) return;
      console.warn(
        "[SurfaceScene] landed rocket GLB failed; using procedural fallback",
        err,
      );
      this.clearRocketModel();
      const fallback = this.createFallbackRocketModel();
      this.rocketModel = fallback;
      this.rocketRoot.add(fallback);
      this.rocketReady = true;
      this.rocketLoading = false;
      this.rocketRoot.visible = true;
    }
  }

  private createFallbackRocketModel(): THREE.Group {
    const group = new THREE.Group();
    group.name = "surface.landedRocket.fallback";

    const white = new THREE.MeshStandardMaterial({
      color: 0xf1f6f8,
      roughness: 0.42,
      metalness: 0.18,
    });
    const orange = new THREE.MeshStandardMaterial({
      color: 0xd87528,
      roughness: 0.55,
      metalness: 0.08,
      emissive: 0x3a1404,
      emissiveIntensity: 0.18,
    });
    const black = new THREE.MeshStandardMaterial({
      color: 0x171b22,
      roughness: 0.45,
      metalness: 0.25,
    });
    const cyan = new THREE.MeshBasicMaterial({
      color: 0x7df9ff,
      transparent: true,
      opacity: 0.68,
    });

    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 4.1, 32), white);
    core.position.y = 2.25;
    group.add(core);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.92, 32), white);
    nose.position.y = 4.75;
    group.add(nose);

    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 3.7, 32), orange);
    tank.position.set(0, 1.95, 0.68);
    group.add(tank);

    const boosterGeom = new THREE.CylinderGeometry(0.22, 0.28, 3.35, 24);
    [-0.55, 0.55].forEach((x) => {
      const booster = new THREE.Mesh(boosterGeom, white);
      booster.position.set(x, 1.82, -0.08);
      group.add(booster);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.36, 24), white);
      cap.position.set(x, 3.67, -0.08);
      group.add(cap);
    });

    const bandGeom = new THREE.CylinderGeometry(0.535, 0.535, 0.12, 32);
    [1.1, 2.38, 3.52].forEach((y) => {
      const band = new THREE.Mesh(bandGeom, black);
      band.position.y = y;
      group.add(band);
    });

    const finGeom = new THREE.BoxGeometry(0.12, 0.55, 0.78);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeom, black);
      fin.position.set(Math.sin(i * Math.PI / 2) * 0.54, 0.38, Math.cos(i * Math.PI / 2) * 0.54);
      fin.rotation.y = i * Math.PI / 2;
      group.add(fin);
    }

    const window = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 12), cyan);
    window.position.set(0, 4.35, -0.37);
    window.scale.set(1, 0.62, 0.18);
    group.add(window);

    group.rotation.set(0, 0.18, 0);
    return group;
  }

  private clearRocketModel(): void {
    if (!this.rocketModel) return;
    this.rocketRoot.remove(this.rocketModel);
    disposeObjectTree(this.rocketModel);
    this.rocketModel = null;
  }

  private updateRocketInteraction(delta: number, elapsed: number): void {
    this.rocketRoot.getWorldPosition(this._rocketWorldPos);
    this.rocketDistance = this.camera.position.distanceTo(this._rocketWorldPos);
    this.rocketInRange = this.rocketReady && this.rocketDistance <= ROCKET_BOARD_RANGE;
    this.rocketHintVisible =
      this.rocketReady &&
      !this.rocketBoarding &&
      this.rocketDistance <= ROCKET_HINT_RANGE;

    const targetGlow = this.rocketInRange ? 1 : this.rocketHintVisible ? 0.45 : 0.12;
    this.rocketGlow = damp(this.rocketGlow, targetGlow, 5.5, delta);
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
    this.beaconLights.forEach((light, idx) => {
      const phase = 0.65 + 0.35 * Math.sin(elapsed * 2.8 + idx * 1.1);
      light.intensity = (0.22 + this.rocketGlow * 0.95) * (0.72 + pulse * 0.28) * phase;
    });

    this.rocketPad.scale.setScalar(1 + this.rocketGlow * 0.015);
  }

  private resetMovement(): void {
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.moveUp = false;
    this.moveDown = false;
    this.sprint = false;
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.rocketBoarding) return;
    switch (e.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = true;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = true;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = true;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = true;
        break;
      case "Space":
        this.moveUp = true;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.sprint = true;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.moveDown = true;
        break;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.robotaxiState !== "touring") return;
    if (!this.controls.isLocked && e.buttons === 0) return;

    this.rideLookYawOffset = THREE.MathUtils.clamp(
      this.rideLookYawOffset - e.movementX * 0.0025,
      -ROBOTAXI_LOOK_YAW_LIMIT,
      ROBOTAXI_LOOK_YAW_LIMIT,
    );
    this.rideLookPitchOffset = THREE.MathUtils.clamp(
      this.rideLookPitchOffset - e.movementY * 0.0019,
      -ROBOTAXI_LOOK_PITCH_LIMIT,
      ROBOTAXI_LOOK_PITCH_LIMIT,
    );
  };

  private readonly onCanvasPointerDown = (): void => {
    if (this.robotaxiState !== "touring") return;
    this.requestPointerLock();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = false;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = false;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = false;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = false;
        break;
      case "Space":
        this.moveUp = false;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.sprint = false;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.moveDown = false;
        break;
    }
  };
}
