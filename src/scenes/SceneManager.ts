import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import { LaunchScene } from "./LaunchScene";
import { FlightScene } from "./FlightScene";
import { SurfaceScene } from "./SurfaceScene";
import { mountLaunchHud } from "../hud/launchControl";
import { mountSelectHud } from "../hud/destinationSelector";
import { mountFlightHud } from "../hud/flightHud";
import { mountArrivalHud } from "../hud/arrivalHud";
import { mountSurfaceHud } from "../hud/surfaceHud";
import { getPlanet, type Planet } from "../data/planets";
import { playCue, startDrone, stopDrone, unlockAudio } from "../util/audio";
import { createPostFx, type PostFx } from "../util/post";

export type AppState =
  | "launch"
  | "select"
  | "flight"
  | "arrival"
  | "surface";

const SCREEN_BY_STATE: Record<AppState, string> = {
  launch: "screen-launch",
  select: "screen-select",
  flight: "screen-flight",
  arrival: "screen-arrival",
  surface: "screen-surface",
};

export class SceneManager {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly spark: SparkRenderer;
  private readonly post: PostFx;

  private readonly launch: LaunchScene;
  private readonly flight: FlightScene;
  private readonly surface: SurfaceScene;

  private active: SceneSlot;
  private state: AppState = "launch";
  private selectedPlanet: Planet | null = null;

  private lastTime = 0;
  private elapsed = 0;
  private hudCleanups: Array<() => void> = [];
  private flashEl: HTMLElement | null = null;

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
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x05070b, 1);

    this.spark = new SparkRenderer({ renderer: this.renderer });

    this.post = createPostFx(this.renderer);
    this.flashEl = document.getElementById("flash");

    this.launch = new LaunchScene(canvas);
    this.flight = new FlightScene();
    this.surface = new SurfaceScene(this.spark, canvas);

    this.active = this.launch;
    this.launch.enter();

    window.addEventListener("resize", this.onResize);
    this.onResize();

    this.installHud();
    this.updateScreenVisibility();

    this.renderer.setAnimationLoop(this.tick);
  }

  /* ============================================================
   * State machine
   * ============================================================ */

  setState(next: AppState): void {
    if (next === this.state) return;
    this.state = next;
    this.updateScreenVisibility();
    this.flashTransition();

    switch (next) {
      case "launch": {
        this.swapScene(this.launch);
        this.launch.frameEarth();
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
      this.renderer.toneMappingExposure = 1.1;
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
          this.setState("select");
        },
      }),
    );

    this.hudCleanups.push(
      mountSelectHud({
        onSelect: (planet) => {
          this.selectedPlanet = planet;
          playCue("click");
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

    this.active.update(delta, this.elapsed);

    // Auto-advance from flight → arrival when transit completes.
    if (this.state === "flight" && this.flight.progress >= 1) {
      this.setState("arrival");
    }

    if (this.post.bypass) {
      this.renderer.render(this.active.scene, this.active.camera);
    } else {
      this.post.setScene(this.active.scene, this.active.camera);
      this.post.render(delta);
    }
  };

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.launch.resize(w, h);
    this.flight.resize(w, h);
    this.surface.resize(w, h);
  };

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    stopDrone();
    this.hudCleanups.forEach((fn) => fn());
    this.launch.dispose();
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
}
