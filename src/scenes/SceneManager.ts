import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import { LaunchScene } from "./LaunchScene";
import { HangarScene } from "./HangarScene";
import { FlightScene } from "./FlightScene";
import { MissionScene } from "./MissionScene";
import { SurfaceScene } from "./SurfaceScene";
import { mountHangarHud, mountLaunchHud } from "../hud/launchControl";
import { mountSelectHud } from "../hud/destinationSelector";
import { mountFlightHud } from "../hud/flightHud";
import { mountSurfaceHud } from "../hud/surfaceHud";
import { getPlanet, type Planet } from "../data/planets";
import {
  playCue,
  setDroneFlightState,
  startDrone,
  stopDrone,
  unlockAudio,
} from "../util/audio";
import { createPostFx, type PostFx } from "../util/post";
import { FlightInput, type FlightInputSnapshot } from "./FlightInput";
import { damp } from "../util/feel";

/**
 * Top-level app state machine. The mission state runs the entire continuous
 * flight from Earth pad → cruise → approach → touchdown; on touchdown the
 * scene fires a handoff event and we swap to `surface` (walking) with the
 * ship's final transform as the spawn pose. The legacy `flight` / `arrival`
 * states are retained only so the hangar/launch screens that still link
 * back to them keep compiling — the new flow doesn't enter them.
 */
export type AppState =
  | "launch"
  | "hangar"
  | "select"
  | "mission"
  | "surface";

const SCREEN_BY_STATE: Record<AppState, string> = {
  launch: "screen-launch",
  hangar: "screen-hangar",
  select: "screen-select",
  // Mission reuses the flight HUD chrome — phase strip / altimeter etc. are
  // grafted on by the HUD code in a later todo.
  mission: "screen-flight",
  surface: "screen-surface",
};

/** Side-nav highlight: which "screen" link should be active for each state. */
const SIDE_NAV_BY_STATE: Record<AppState, string> = {
  launch: "launch",
  hangar: "launch",
  select: "select",
  mission: "flight",
  surface: "surface",
};

/** Top-bar highlight: which top-level section should be active for each state. */
const TOP_NAV_BY_STATE: Record<AppState, string> = {
  launch: "hangar",
  hangar: "hangar",
  select: "control",
  mission: "telemetry",
  surface: "fleet",
};

export class SceneManager {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly spark: SparkRenderer;
  private readonly post: PostFx;

  // Public for the debug HUD so it can identify which scene is rendering
  // without us having to thread state/slot identity through manager methods.
  readonly launch: LaunchScene;
  readonly hangar: HangarScene;
  readonly flight: FlightScene; // legacy cinematic transit (kept for fallback)
  readonly mission: MissionScene;
  readonly surface: SurfaceScene;

  private active: SceneSlot;
  private state: AppState = "launch";
  private selectedPlanet: Planet | null = null;

  private lastTime = 0;
  private elapsed = 0;
  private hudCleanups: Array<() => void> = [];
  private flashEl: HTMLElement | null = null;
  private viewToggleListeners: Array<(mode: "cockpit" | "chase" | "external") => void> = [];
  private inputListeners: Array<(snapshot: FlightInputSnapshot) => void> = [];
  private controlModeListeners: Array<(mode: "auto" | "manual" | "free-fly") => void> = [];
  private helpToggleListeners: Array<() => void> = [];

  private flightInput: FlightInput;
  private lastInput: FlightInputSnapshot;
  private bloomBias = 1;
  private grainBias = 0.04;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Splats don't benefit from MSAA (Spark perf guide); turning AA off
      // gives a real FPS boost on the surface scene where they dominate.
      antialias: false,
      powerPreference: "high-performance",
    });
    // Cap pixel ratio at 1.5 — bloom + grain + splats get expensive at 2x.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x05070b, 1);

    this.spark = new SparkRenderer({ renderer: this.renderer });

    this.post = createPostFx(this.renderer);
    this.flashEl = document.getElementById("flash");

    this.launch = new LaunchScene(canvas);
    this.hangar = new HangarScene(canvas, this.spark);
    this.flight = new FlightScene(this.spark);
    this.mission = new MissionScene(this.spark);
    this.mission.setEvents({
      onPhaseChange: (next) => {
        // Each phase transition gets a single cue. The drone keeps running
        // continuously (modulated by throttle/boost via setDroneFlightState
        // each frame); these cues just punctuate the moment.
        switch (next) {
          case "cruise":
            playCue("warp");
            break;
          case "approach":
            playCue("arrive");
            this.post.setIntensity("calm");
            break;
          case "touchdown":
            playCue("land");
            break;
          case "landed":
            playCue("boostThump");
            break;
        }
      },
      onTouchdown: ({ spawnPose }) => {
        this.surface.setSpawnPose?.(spawnPose);
        this.setState("surface");
      },
      onControlModeChange: (next) => {
        this.controlModeListeners.forEach((cb) => cb(next));
        // Quick audio feedback so the player gets confirmation. We map
        // each mode to an existing cue rather than introduce new ones.
        playCue(next === "auto" ? "viewToggle" : next === "free-fly" ? "boostThump" : "click");
      },
    });
    this.surface = new SurfaceScene(this.spark, canvas);

    this.flightInput = new FlightInput(canvas);
    this.lastInput = {
      pitch: 0, yaw: 0, roll: 0,
      throttle: 1, boost: 0, boostCharge: 1, boosting: false,
      headLookYaw: 0, headLookPitch: 0,
      brake: false, retrograde: false, prograde: false, level: false,
      lookBack: false,
    };

    // Wire FlightInput edge-triggered events into the mission scene.
    this.flightInput.setEvents({
      onAnyDeliberateInput: () => {
        if (this.state !== "mission") return;
        // First flight key pressed → flip auto → manual. Free-fly is
        // preserved (player must explicitly leave free-fly via F or Tab).
        if (this.mission.controlMode === "auto") {
          this.mission.setControlMode("manual");
        }
      },
      onAutopilotToggle: () => {
        if (this.state !== "mission") return;
        this.mission.toggleAutopilot();
      },
      onFreeFlyToggle: () => {
        if (this.state !== "mission") return;
        this.mission.toggleFreeFly();
      },
      onSetView: (mode) => {
        if (this.state !== "mission") return;
        this.mission.setView(mode);
        playCue("viewToggle");
        this.viewToggleListeners.forEach((cb) => cb(mode));
      },
      onToggleHelp: () => {
        if (this.state !== "mission") return;
        this.helpToggleListeners.forEach((cb) => cb());
      },
    });

    this.active = this.launch;
    this.launch.enter();

    window.addEventListener("resize", this.onResize);
    this.onResize();

    this.installHud();
    this.updateScreenVisibility();

    window.addEventListener("keydown", this.onGlobalKey);

    this.renderer.setAnimationLoop(this.tick);
  }

  /**
   * App-wide key handler: only the view-mode toggle is registered globally,
   * so it works whether or not pointer-lock is active. Auto-ignition makes
   * keyboard ignition unnecessary.
   */
  private readonly onGlobalKey = (e: KeyboardEvent): void => {
    if (e.code === "KeyC" && !e.repeat) {
      if (this.state === "mission") {
        this.mission.toggleView();
        playCue("viewToggle");
        const mode = this.mission.viewMode;
        this.viewToggleListeners.forEach((cb) => cb(mode));
      }
    }
  };

  /** HUD subscribes here to update the view-mode badge. */
  onViewToggle(cb: (mode: "cockpit" | "chase" | "external") => void): () => void {
    this.viewToggleListeners.push(cb);
    return () => {
      this.viewToggleListeners = this.viewToggleListeners.filter(
        (x) => x !== cb,
      );
    };
  }

  /** HUD subscribes here for per-frame flight input snapshots. */
  onFlightInput(cb: (snapshot: FlightInputSnapshot) => void): () => void {
    this.inputListeners.push(cb);
    return () => {
      this.inputListeners = this.inputListeners.filter((x) => x !== cb);
    };
  }

  /** HUD subscribes here for control-mode changes (auto / manual / free-fly). */
  onControlModeChange(
    cb: (mode: "auto" | "manual" | "free-fly") => void,
  ): () => void {
    this.controlModeListeners.push(cb);
    return () => {
      this.controlModeListeners = this.controlModeListeners.filter(
        (x) => x !== cb,
      );
    };
  }

  /** HUD subscribes here to be notified when the player presses H. */
  onHelpToggle(cb: () => void): () => void {
    this.helpToggleListeners.push(cb);
    return () => {
      this.helpToggleListeners = this.helpToggleListeners.filter(
        (x) => x !== cb,
      );
    };
  }

  /** Read current control mode (for HUD initial render). */
  getControlMode(): "auto" | "manual" | "free-fly" {
    return this.mission.controlMode;
  }

  getFlightViewMode(): "cockpit" | "chase" | "external" {
    return this.state === "mission"
      ? this.mission.viewMode
      : this.flight.viewMode;
  }

  /** Request pointer lock for cockpit mouse-look. HUD calls on click. */
  requestFlightPointerLock(): void {
    this.flightInput.requestPointerLock();
  }

  /* ============================================================
   * State machine
   * ============================================================ */

  setState(next: AppState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.updateScreenVisibility();
    this.flashTransition();

    // Tear down flight input when leaving the playable mission.
    if (prev === "mission" && next !== "mission") {
      this.flightInput.stop();
    }

    switch (next) {
      case "launch": {
        this.swapScene(this.launch);
        this.launch.frameEarth();
        this.post.setIntensity("default");
        stopDrone();
        break;
      }
      case "hangar": {
        this.swapScene(this.hangar);
        this.post.setIntensity("default");
        stopDrone();
        break;
      }
      case "select": {
        this.swapScene(this.launch);
        this.launch.frameOrbit();
        this.post.setIntensity("default");
        stopDrone();
        break;
      }
      case "mission": {
        if (!this.selectedPlanet) {
          this.setState("select");
          return;
        }
        this.swapScene(this.mission);
        this.mission.beginMission(this.selectedPlanet);
        // Mission starts in calm liftoff feel — bloom ramps up via phase
        // biases when we hit cruise.
        this.post.setIntensity("default");
        playCue("launch");
        startDrone();
        this.flightInput.reset();
        this.flightInput.start();
        // Try to auto-engage pointer lock on the back of the launch
        // button gesture. If the browser denies (no recent gesture), the
        // existing click-on-canvas path remains as a fallback.
        try {
          this.flightInput.requestPointerLock();
        } catch {
          /* swallow — pointer lock not available */
        }
        break;
      }
      case "surface": {
        if (!this.selectedPlanet) {
          this.setState("select");
          return;
        }
        // Marble worlds carry their own lighting + atmospheric haze.
        // Render them straight to canvas with no tone-map / bloom / grain
        // so the photoreal detail shows through.
        this.post.bypass = true;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        stopDrone();
        playCue("land");
        this.swapScene(this.surface);
        void this.surface.loadPlanet(this.selectedPlanet);
        break;
      }
    }

    // For every cinematic state, restore the stylised pipeline.
    if (next !== "surface") {
      this.post.bypass = false;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = next === "hangar" ? 0.92 : 1.1;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    }
  }

  /** Flash a brief blue-tinted overlay at every transition. */
  private flashTransition(): void {
    if (!this.flashEl) return;
    this.flashEl.classList.remove("is-flashing");
    // Force reflow to retrigger the animation.
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add("is-flashing");
  }

  /* ============================================================
   * HUD wiring
   * ============================================================ */

  private installHud(): void {
    this.hudCleanups.push(
      mountLaunchHud({
        onLaunch: () => {
          unlockAudio();
          playCue("launch");
          this.setState("hangar");
        },
        onHangar: () => {
          unlockAudio();
          playCue("click");
          this.setState("hangar");
        },
      }),
    );

    this.hudCleanups.push(
      mountHangarHud({
        getStatus: () => this.hangar.status,
        onContinue: () => this.setState("select"),
      }),
    );

    this.hudCleanups.push(
      mountSelectHud({
        onPreview: () => {},
        onSelect: (planet) => {
          this.selectedPlanet = planet;
        },
        onLaunch: (planet) => {
          this.selectedPlanet = planet;
          this.setState("mission");
        },
      }),
    );

    // Mission reuses the flight HUD chrome — telemetry is sourced from the
    // mission scene's live ship state. ETA and "skip" are no longer
    // meaningful in continuous flight, so they're stubbed.
    this.hudCleanups.push(
      mountFlightHud({
        getVelocityKmS: () => this.mission.getTelemetry().speedKmS,
        getDistanceKm: () => this.mission.getTelemetry().rangeKm,
        getTarget: () => this.selectedPlanet,
        onFlightInput: (cb) => this.onFlightInput(cb),
        onViewToggle: (cb) => this.onViewToggle(cb),
        getViewMode: () => this.getFlightViewMode(),
        onLockRequest: () => this.requestFlightPointerLock(),
        onSkipToLanding: () => {
          if (this.state !== "mission") return;
          playCue("click");
          this.mission.skipToLanding();
        },
        getMissionTelemetry: () => {
          const t = this.mission.getTelemetry();
          // Switch the altimeter to "destination AGL" once we're inside
          // approach range so the readout is meaningful for landing.
          const useDest =
            t.phase === "approach" ||
            t.phase === "touchdown" ||
            t.phase === "landed";
          return {
            phase: t.phase,
            altitudeKm: useDest ? t.destinationAltitudeKm : t.altitudeKm,
            altitudeIsDestination: useDest,
          };
        },
      }),
    );

    this.hudCleanups.push(
      mountSurfaceHud({
        getTarget: () => this.selectedPlanet,
        getStatus: () => this.surface.status,
        getProgress: () => this.surface.progress,
        onLockRequest: () => this.surface.requestPointerLock(),
        onPointerLockState: (cb) => this.surface.onLockChange(cb),
        onReturn: () => this.setState("select"),
      }),
    );
  }

  private updateScreenVisibility(): void {
    const target = SCREEN_BY_STATE[this.state];
    document.querySelectorAll<HTMLElement>(".hud-screen").forEach((el) => {
      el.classList.toggle("is-active", el.id === target);
    });

    // Tag #hud-root with the active screen so global decorations
    // (scanlines / vignette) can be suppressed in flight mode.
    const hudRoot = document.getElementById("hud-root");
    if (hudRoot) {
      hudRoot.dataset.screen = SIDE_NAV_BY_STATE[this.state];
    }

    const sideTarget = SIDE_NAV_BY_STATE[this.state];
    document.querySelectorAll<HTMLElement>(".side-link").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.screen === sideTarget);
    });

    const topTarget = TOP_NAV_BY_STATE[this.state];
    document.querySelectorAll<HTMLElement>(".nav-link").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.section === topTarget);
    });
  }

  /* ============================================================
   * Scene swapping & loop
   * ============================================================ */

  private swapScene(next: SceneSlot): void {
    if (next === this.active) return;
    this.active.exit();
    this.active = next;
    this.active.resize(window.innerWidth, window.innerHeight);
    this.active.enter();
  }

  private readonly tick = (timeMs: number): void => {
    const last = this.lastTime || timeMs;
    const delta = Math.min(0.1, (timeMs - last) / 1000);
    this.lastTime = timeMs;
    this.elapsed += delta;

    // Pump flight input first so the mission scene update sees fresh values.
    if (this.state === "mission") {
      // Mouse stays "alive" across all view modes — cockpit interprets it
      // as head-look, chase as orbital cam yaw/pitch, external as free
      // orbit around a fixed anchor. The rig does the per-mode mapping.
      this.flightInput.setHeadLookEnabled(true);
      this.lastInput = this.flightInput.step(delta);

      // Map the input snapshot to the mission's FlightDynamics input shape
      // (rate commands instead of pose targets).
      this.mission.setInput({
        pitchRate: clamp1(this.lastInput.pitch / 0.38),
        yawRate: clamp1(this.lastInput.yaw / 0.38),
        rollRate: clamp1(this.lastInput.roll / 0.61),
        throttle: this.lastInput.throttle,
        boost: this.lastInput.boost,
        headLookYaw: this.lastInput.headLookYaw,
        headLookPitch: this.lastInput.headLookPitch,
      });
      // Held flight-assist booleans (brake / retro / pro / level).
      this.mission.setFlightAssist({
        brake: this.lastInput.brake,
        retrograde: this.lastInput.retrograde,
        prograde: this.lastInput.prograde,
        level: this.lastInput.level,
      });

      // Post-fx + drone breathe with throttle / boost. The mission's own
      // phase feel adds extra bloom bias on top of the input bias.
      const phaseBias = this.mission.getDebugSnapshot().feel.bloomBias;
      const targetBloomMul = 1 + this.lastInput.boost * 0.35 + phaseBias;
      this.bloomBias = damp(this.bloomBias, targetBloomMul, 6, delta);
      const targetGrain = 0.04 + this.lastInput.boost * 0.025;
      this.grainBias = damp(this.grainBias, targetGrain, 5, delta);
      this.post.setBias({ bloomMul: this.bloomBias, grain: this.grainBias });
      setDroneFlightState(this.lastInput.throttle, this.lastInput.boost);

      this.inputListeners.forEach((cb) => cb(this.lastInput));
    }

    this.active.update(delta, this.elapsed);

    if (this.post.bypass) {
      // Make sure we draw to the canvas, not whatever offscreen target the
      // EffectComposer last bound. Without this, the very first frame after
      // the post-fx pipeline disengages can render into a stale ping-pong
      // buffer and the viewer flashes black.
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.active.scene, this.active.camera);
    } else {
      this.post.setScene(this.active.scene, this.active.camera);
      this.post.render(delta);
    }
  };

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    this.launch.resize(w, h);
    this.hangar.resize(w, h);
    this.flight.resize(w, h);
    this.mission.resize(w, h);
    this.surface.resize(w, h);
  };

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onGlobalKey);
    stopDrone();
    this.hudCleanups.forEach((fn) => fn());
    this.launch.dispose();
    this.hangar.dispose();
    this.flight.dispose();
    this.mission.dispose();
    this.surface.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }

  /* Utility for HUD helpers that need to look up a planet by id. */
  pickPlanet(id: string): void {
    this.selectedPlanet = getPlanet(id);
    this.setState("mission");
  }

  /** Snapshot used by the on-screen debug HUD. */
  getDebugState(): {
    state: AppState;
    active: SceneSlot;
    selectedPlanet: Planet | null;
    flight: ReturnType<FlightScene["getDestinationDebugSnapshot"]>;
    surface: ReturnType<SurfaceScene["getDebugSnapshot"]>;
  } {
    return {
      state: this.state,
      active: this.active,
      selectedPlanet: this.selectedPlanet,
      flight: this.flight.getDestinationDebugSnapshot(),
      surface: this.surface.getDebugSnapshot(),
    };
  }
}

function clamp1(x: number): number {
  return Math.max(-1, Math.min(1, x));
}
