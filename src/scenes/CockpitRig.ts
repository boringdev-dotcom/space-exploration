import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import {
  createEnginePlume,
  type EnginePlume,
} from "../util/enginePlume";
import {
  Tween,
  damp,
  easeInOutCubic,
  noise1D,
  smoothstep,
} from "../util/feel";

const ARTEMIS_GLB_URL =
  "/models/rockets/artemis_ii_-_space_launch_system_sls.glb";

/**
 * Local-space camera offsets for each view mode. The ship anchor is at the
 * origin of the rig group, looking down -Z. Cockpit places the camera at the
 * pilot seat (slightly forward of, and above, the rocket's center). Chase
 * pulls the camera back along +Z and up.
 *
 * These are tuned to feel cinematic; both views frame the destination ahead
 * along -Z with the rocket either invisible (cockpit) or filling the lower
 * third (chase).
 */
const COCKPIT_OFFSET = new THREE.Vector3(0, 0.0, 0.0);
const CHASE_OFFSET = new THREE.Vector3(0, 2.0, 7.5);

/** FOV per mode — chase is slightly narrower for a more "filmic" look. */
const COCKPIT_FOV = 72;
const CHASE_FOV = 64;

export type ViewMode = "cockpit" | "chase";

interface CockpitRigOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

/**
 * Owns the camera-rig, the Artemis GLB (chase-cam hero), and the cockpit
 * splat (cockpit-cam interior) plus the engine plume. Drives the cinematic
 * 900ms toggle between cockpit and chase views. Reusable across scenes.
 *
 * The rig is added to a host scene as a `THREE.Group` at the origin. The
 * host (FlightScene/HangarScene) drives the rig with `update(dt, elapsed)`
 * and decides whether to apply additional transformations (e.g. flight shake
 * via the `cameraShakeOffset` parameter).
 */
export class CockpitRig {
  /** Root group added to the host scene. Origin = ship anchor. */
  readonly root = new THREE.Group();

  /** Sub-group holding the chase-cam hero (Artemis + plume). */
  private readonly chaseGroup = new THREE.Group();
  /** Sub-group holding the cockpit splat (parented to camera). */
  private readonly cockpitGroup = new THREE.Group();

  private artemis: THREE.Group | null = null;
  private artemisLoaded = false;
  private artemisLoadStarted = false;

  private cockpitSplat: SplatMesh | null = null;
  private cockpitSplatGroup = new THREE.Group();
  private cockpitSplatLoadId = 0;

  private plume: EnginePlume;

  /** Current/target view mode. */
  private _viewMode: ViewMode = "cockpit";
  /** 0 = cockpit, 1 = chase. Smoothly interpolates during a toggle. */
  private viewBlend = 0;
  private viewTween: Tween;

  /** Shake/idle scratch vectors (avoid per-frame allocation). */
  private readonly _scratchOffset = new THREE.Vector3();
  private readonly _scratchLookAt = new THREE.Vector3();
  private readonly _idleSwayPos = new THREE.Vector3();

  private readonly camera: THREE.PerspectiveCamera;

  /** Throttle/boost set by the host every frame; used to drive the plume. */
  private throttle = 1;
  private boost = 0;

  /** External shake offset added every frame, in camera-local space. */
  private extraShakeOffset = new THREE.Vector3();

  constructor(opts: CockpitRigOpts) {
    this.camera = opts.camera;

    this.root.name = "cockpitRig";
    this.root.add(this.chaseGroup);
    this.cockpitGroup.add(this.cockpitSplatGroup);
    // The cockpit group is parented to the camera so its splat moves with
    // the player's head; we add it via the host scene + matrixAuto setup so
    // the camera can be reused across scenes.
    opts.scene.add(this.root);

    // Engine plume sits at the rocket's engine bell, oriented along -Y by
    // default. The Artemis GLB is rotated so its nose points -Z and tail
    // points +Z; we rotate the plume so its fire vector aligns with +Z (the
    // exhaust direction visible to the chase camera).
    this.plume = createEnginePlume({ length: 9, baseRadius: 0.85 });
    this.plume.group.rotation.x = -Math.PI / 2;
    this.plume.group.position.set(0, -0.6, 2.0);
    this.chaseGroup.add(this.plume.group);

    this.viewTween = new Tween(0.9, easeInOutCubic, (eased) => {
      this.viewBlend = this._viewMode === "chase" ? eased : 1 - eased;
    });

    void this.loadArtemis();
  }

  attachCockpitToCamera(): void {
    if (this.cockpitGroup.parent !== this.camera) {
      this.camera.add(this.cockpitGroup);
    }
  }

  detachCockpitFromCamera(): void {
    if (this.cockpitGroup.parent === this.camera) {
      this.camera.remove(this.cockpitGroup);
    }
  }

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  /** Smoothly toggle between cockpit and chase. Debounced via Tween reuse. */
  toggleView(): void {
    this.setView(this._viewMode === "cockpit" ? "chase" : "cockpit");
  }

  setView(mode: ViewMode, immediate = false): void {
    if (mode === this._viewMode && !immediate) return;
    this._viewMode = mode;
    if (immediate) {
      this.viewTween.cancel();
      this.viewBlend = mode === "chase" ? 1 : 0;
    } else {
      this.viewTween.start();
    }
  }

  /** Apply external camera shake on top of the rig motion (in camera-local space). */
  setExtraShake(offset: THREE.Vector3): void {
    this.extraShakeOffset.copy(offset);
  }

  /** Set throttle (0..2) and boost (0..1) so the plume reacts. */
  setThrottle(throttle: number, boost: number): void {
    this.throttle = Math.max(0, Math.min(2, throttle));
    this.boost = Math.max(0, Math.min(1, boost));
  }

  /**
   * Drive the rig every frame from the host scene's update loop. `dt` and
   * `elapsed` are seconds.
   */
  update(dt: number, elapsed: number): void {
    this.viewTween.update(dt);

    // Smoothly drive the blend even when the tween isn't active so calls to
    // setView({immediate: true}) don't visibly jitter.
    const targetBlend = this._viewMode === "chase" ? 1 : 0;
    if (!this.viewTween.isActive) {
      this.viewBlend = damp(this.viewBlend, targetBlend, 8, dt);
    }

    const t = this.viewBlend;
    const easedT = easeInOutCubic(t);

    // Camera offset: lerp between cockpit and chase.
    this._scratchOffset
      .copy(COCKPIT_OFFSET)
      .lerp(CHASE_OFFSET, easedT);

    // Idle hand-held sway. Scaled DOWN inside cockpit (more grounded) and
    // UP in chase (more cinematic parallax).
    const swayAmp = 0.012 + 0.04 * easedT;
    this._idleSwayPos.set(
      noise1D(elapsed * 0.6, 1.7) * swayAmp,
      noise1D(elapsed * 0.5, 4.2) * swayAmp * 0.7,
      noise1D(elapsed * 0.4, 7.3) * swayAmp * 0.5,
    );

    // Compose final camera position in world space (root frame is the ship
    // anchor at origin; we drop the rig's worldMatrix into a local copy).
    this.camera.position
      .copy(this.root.position)
      .add(this._scratchOffset)
      .add(this._idleSwayPos)
      .add(this.extraShakeOffset);

    // Camera look target. In cockpit mode look forward (-Z); in chase mode
    // look slightly down at the rocket centroid.
    const lookCockpit = this._scratchLookAt.set(0, 0, -10);
    const lookChase = new THREE.Vector3(0, -0.4, 0); // bias slightly down
    const lookFinal = lookCockpit.lerp(lookChase, easedT);
    this.camera.lookAt(lookFinal);

    // FOV breathes between modes.
    const targetFov = COCKPIT_FOV + (CHASE_FOV - COCKPIT_FOV) * easedT;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
      this.camera.updateProjectionMatrix();
    }

    // Visibility: cross-fade rocket in/out. We keep both groups attached;
    // visibility flips at the midpoint to avoid double-render artifacts.
    const showChase = easedT > 0.5;
    this.chaseGroup.visible = easedT > 0.02;
    this.cockpitGroup.visible = easedT < 0.98;

    // Smoothly scale the rocket so it grows in instead of popping. Use a
    // per-frame damped scale rather than a hard switch.
    if (this.artemis) {
      const targetScale = showChase ? 1 : 0.001;
      const s = damp(this.artemis.scale.x, targetScale, 7, dt);
      this.artemis.scale.setScalar(s);
    }

    // Plume responds to throttle/boost; only worth updating when visible.
    this.plume.group.visible = easedT > 0.02 && this.throttle > 0.05;
    if (this.plume.group.visible) {
      this.plume.setState(this.throttle, this.boost);
      this.plume.update(dt, elapsed);
    }

    // Cockpit splat slow drift — "cabin breathing" — so the interior never
    // feels static. Only meaningful in cockpit mode.
    const cockpitWeight = 1 - easedT;
    if (this.cockpitSplatGroup && cockpitWeight > 0.001) {
      const breath = Math.sin(elapsed * 1.05) * 0.0035 * cockpitWeight;
      const swayRoll = noise1D(elapsed * 0.18, 12.5) * 0.012 * cockpitWeight;
      this.cockpitSplatGroup.position.z = breath;
      this.cockpitSplatGroup.rotation.z = swayRoll;
    }
  }

  /** Visibility helper — host can hide chase rocket entirely if desired. */
  setChaseVisible(visible: boolean): void {
    this.chaseGroup.visible = visible;
  }

  /**
   * Plug a generated cockpit splat into the rig. Pose options come from the
   * cockpit data record; visibility/parenting is managed automatically.
   */
  async setCockpitSplat(opts: {
    splatUrl: string;
    cameraOffset?: [number, number, number];
    splatRotation?: [number, number, number];
    splatScale?: number;
  }): Promise<void> {
    this.cockpitSplatLoadId++;
    const loadId = this.cockpitSplatLoadId;

    // Tear down any prior splat.
    if (this.cockpitSplat) {
      this.cockpitSplatGroup.remove(this.cockpitSplat);
      this.cockpitSplat.dispose?.();
      this.cockpitSplat = null;
    }

    const splat = new SplatMesh({ url: opts.splatUrl });
    // Spark's right-side-up convention (180° around X) — Marble exports Y-down.
    splat.quaternion.set(1, 0, 0, 0);
    if (opts.splatRotation) {
      const e = new THREE.Euler(...opts.splatRotation);
      const q = new THREE.Quaternion().setFromEuler(e);
      splat.quaternion.premultiply(q);
    }
    if (opts.cameraOffset) {
      splat.position.set(...opts.cameraOffset);
    }
    if (opts.splatScale) splat.scale.setScalar(opts.splatScale);

    // Render order so it always sits on top of the flight scene; depth test
    // off so we don't depth-fight the procedural skybox behind it.
    splat.renderOrder = 10;

    try {
      await splat.initialized;
      if (loadId !== this.cockpitSplatLoadId) {
        splat.dispose?.();
        return;
      }
      this.cockpitSplat = splat;
      this.cockpitSplatGroup.add(splat);
      this.attachCockpitToCamera();
    } catch (err) {
      console.warn("[CockpitRig] cockpit splat failed to load", err);
    }
  }

  /** Whether the Artemis GLB is attached and ready (for status surfacing). */
  get artemisReady(): boolean {
    return this.artemisLoaded;
  }

  dispose(): void {
    this.plume.dispose();
    if (this.artemis) {
      disposeObjectTree(this.artemis);
      this.chaseGroup.remove(this.artemis);
    }
    if (this.cockpitSplat) {
      this.cockpitSplatGroup.remove(this.cockpitSplat);
      this.cockpitSplat.dispose?.();
    }
    if (this.cockpitGroup.parent) {
      this.cockpitGroup.parent.remove(this.cockpitGroup);
    }
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  private async loadArtemis(): Promise<void> {
    if (this.artemisLoadStarted) return;
    this.artemisLoadStarted = true;
    try {
      const model = await loadNormalizedGltfModel(ARTEMIS_GLB_URL, 4.5);
      // Orient the rocket so the nose points toward -Z (forward) and the
      // engine bell sits at +Z. Models we ship are typically nose-up (+Y);
      // we tilt 90° around X so the body lies along -Z.
      model.rotation.x = -Math.PI / 2;
      // Push slightly forward in the rig so the chase camera looks at the
      // rocket's mid-body rather than its nose.
      model.position.set(0, -0.6, 0);
      this.artemis = model;
      this.artemis.scale.setScalar(0.001);
      this.chaseGroup.add(this.artemis);
      this.artemisLoaded = true;
    } catch (err) {
      console.warn("[CockpitRig] Artemis GLB failed to load", err);
    }
  }

  /** Snapshot for the debug HUD. */
  getDebugSnapshot(): { mode: ViewMode; blend: number; artemisReady: boolean } {
    return {
      mode: this._viewMode,
      blend: this.viewBlend,
      artemisReady: this.artemisLoaded,
    };
  }
}

// Suppress unused import warnings for helpers that may be useful later.
void smoothstep;
