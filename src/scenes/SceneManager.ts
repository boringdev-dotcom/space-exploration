import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import { LaunchScene } from "./LaunchScene";
import { HangarScene } from "./HangarScene";
import { FlightScene } from "./FlightScene";
import { SurfaceScene } from "./SurfaceScene";
import { mountHangarHud, mountLaunchHud } from "../hud/launchControl";
import { mountSelectHud } from "../hud/destinationSelector";
import { mountFlightHud } from "../hud/flightHud";
import { mountArrivalHud } from "../hud/arrivalHud";
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

export type AppState =
  | "launch"
  | "hangar"
  | "select"
  | "flight"
  | "arrival"
  | "surface";

const SCREEN_BY_STATE: Record<AppState, string> = {
  launch: "screen-launch",
  hangar: "screen-hangar",
  select: "screen-select",
  flight: "screen-flight",
  arrival: "screen-arrival",
  surface: "screen-surface",
};

/** Side-nav highlight: which "screen" link should be active for each state. */
const SIDE_NAV_BY_STATE: Record<AppState, string> = {
  launch: "launch",
  hangar: "launch",
  select: "select",
  flight: "flight",
  arrival: "flight",
  surface: "surface",
};

/** Top-bar highlight: which top-level section should be active for each state. */
const TOP_NAV_BY_STATE: Record<AppState, string> = {
  launch: "hangar",
  hangar: "hangar",
  select: "control",
  flight: "telemetry",
  arrival: "telemetry",
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
  readonly flight: FlightScene;
  readonly surface: SurfaceScene;

  private active: SceneSlot;
  private state: AppState = "launch";
  private selectedPlanet: Planet | null = null;

  private lastTime = 0;
  private elapsed = 0;
  private hudCleanups: Array<() => void> = [];
  private flashEl: HTMLElement | null = null;
  private viewToggleListeners: Array<(mode: "cockpit" | "chase") => void> = [];
  private inputListeners: Array<(snapshot: FlightInputSnapshot) => void> = [];

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
    this.surface = new SurfaceScene(this.spark, canvas);

    this.flightInput = new FlightInput(canvas);
    this.lastInput = {
      pitch: 0, yaw: 0, roll: 0,
      throttle: 1, boost: 0, boostCharge: 1, boosting: false,
    };

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
   * so it works whether or not pointer-lock is active.
   */
  private readonly onGlobalKey = (e: KeyboardEvent): void => {
    if (e.code !== "KeyC") return;
    if (this.state !== "flight" && this.state !== "arrival") return;
    if (e.repeat) return;
    this.flight.toggleView();
    playCue("viewToggle");
    const mode = this.flight.viewMode;
    this.viewToggleListeners.forEach((cb) => cb(mode));
  };

  /** HUD subscribes here to update the view-mode badge. */
  onViewToggle(cb: (mode: "cockpit" | "chase") => void): () => void {
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

  getFlightViewMode(): "cockpit" | "chase" {
    return this.flight.viewMode;
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

    // Tear down flight input when leaving the flight loop.
    if (prev === "flight" && next !== "flight" && next !== "arrival") {
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
      case "flight": {
        if (!this.selectedPlanet) {
          this.setState("select");
          return;
        }
        this.swapScene(this.flight);
        this.flight.beginTransit(this.selectedPlanet);
        this.post.setIntensity("warp");
        playCue("warp");
        startDrone();
        this.flightInput.reset();
        this.flightInput.start();
        break;
      }
      case "arrival": {
        this.flight.beginArrival();
        this.post.setIntensity("calm");
        playCue("arrive");
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
          this.setState("flight");
        },
      }),
    );

    this.hudCleanups.push(
      mountFlightHud({
        getProgress: () => this.flight.progress,
        getVelocityKmS: () => this.flight.velocityKmS,
        getEtaSec: () => this.flight.etaSec,
        getHeading: () => this.flight.headingDeg,
        getDistanceKm: () => this.flight.distanceKm,
        getTarget: () => this.selectedPlanet,
        onArrive: () => this.setState("arrival"),
        onSkip: () => this.flight.skipToArrival(),
        onFlightInput: (cb) => this.onFlightInput(cb),
        onViewToggle: (cb) => this.onViewToggle(cb),
        getViewMode: () => this.getFlightViewMode(),
        onLockRequest: () => this.requestFlightPointerLock(),
      }),
    );

    this.hudCleanups.push(
      mountArrivalHud({
        getTarget: () => this.selectedPlanet,
        onDeploy: () => this.setState("surface"),
        onReroute: () => this.setState("select"),
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

    // Pump flight input first so the flight scene update sees fresh values.
    if (this.state === "flight" || this.state === "arrival") {
      this.lastInput = this.flightInput.step(delta);
      this.flight.setInput({
        pitch: this.lastInput.pitch,
        yaw: this.lastInput.yaw,
        roll: this.lastInput.roll,
        throttle: this.lastInput.throttle,
        boost: this.lastInput.boost,
      });

      // Couple post fx and drone audio to the input so the picture and
      // soundscape *breathe* with throttle and boost.
      const targetBloomMul = 1 + this.lastInput.boost * 0.35;
      this.bloomBias = damp(this.bloomBias, targetBloomMul, 6, delta);
      const targetGrain = 0.04 + this.lastInput.boost * 0.025;
      this.grainBias = damp(this.grainBias, targetGrain, 5, delta);
      this.post.setBias({ bloomMul: this.bloomBias, grain: this.grainBias });
      setDroneFlightState(this.lastInput.throttle, this.lastInput.boost);

      // Notify HUD listeners every frame.
      this.inputListeners.forEach((cb) => cb(this.lastInput));
    }

    this.active.update(delta, this.elapsed);

    // Auto-advance from flight → arrival when transit completes.
    if (this.state === "flight" && this.flight.progress >= 1) {
      this.setState("arrival");
    }

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
    this.surface.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }

  /* Utility for HUD helpers that need to look up a planet by id. */
  pickPlanet(id: string): void {
    this.selectedPlanet = getPlanet(id);
    this.setState("flight");
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
