import * as THREE from "three";
import type { SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import { createStarfield, createWarpStreaks } from "../util/starfield";
import type { Planet } from "../data/planets";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";
import { CockpitRig, type ViewMode } from "./CockpitRig";
import { damp, noise1D } from "../util/feel";
import { COCKPITS } from "../data/cockpits";

/**
 * In-flight + arrival scene. Drives a 25s warp animation toward a planet sphere
 * coloured from the destination's theme. The planet grows from a distant point
 * to a hemisphere by the time `progress` reaches 1.
 */
export class FlightScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private starfield: THREE.Points;
  private warp: THREE.LineSegments;
  private planet: THREE.Mesh;
  private planetMat: THREE.MeshStandardMaterial;
  private halo: THREE.Mesh;
  private haloMat: THREE.ShaderMaterial;
  private planetModel: THREE.Group | null = null;
  private planetModelLoadId = 0;
  private sun: THREE.DirectionalLight;

  private travelDurationSec = 25;
  private travelTimeSec = 0;
  private active = false;
  private arrivalMode = false;
  private currentPlanet: Planet | null = null;

  /** Cockpit rig (Artemis GLB + plume + cockpit splat + view-mode dolly). */
  readonly rig: CockpitRig;

  /** Reusable scratch vector for camera shake. */
  private readonly _shakeScratch = new THREE.Vector3();

  /**
   * Smoothed input state from `FlightInput`. Pitch/yaw/roll are radians,
   * throttle is 0..2, boost is 0..1. The host updates these every frame.
   */
  private inputPitch = 0;
  private inputYaw = 0;
  private inputRoll = 0;
  private inputThrottle = 1;
  private inputBoost = 0;

  /** Spark instance (shared with SurfaceScene). Attached on enter, detached on exit. */
  private readonly spark: SparkRenderer | null;

  constructor(spark?: SparkRenderer) {
    this.spark = spark ?? null;

    this.camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.05,
      4000,
    );
    this.camera.position.set(0, 0, 0);

    this.sun = new THREE.DirectionalLight(0xffefcf, 3.4);
    // Aim the sun roughly at the planet from a "top-side" angle so the
    // approaching crescent is dramatic but the front-facing side is still lit.
    this.sun.position.set(120, 80, -60);
    this.sun.target.position.set(0, 0, -200);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(new THREE.AmbientLight(0x394c66, 0.65));

    this.starfield = createStarfield({ count: 6000, radius: 1500 });
    this.scene.add(this.starfield);

    this.warp = createWarpStreaks(1400, 80);
    this.scene.add(this.warp);

    const planetGeom = new THREE.SphereGeometry(80, 96, 96);
    this.planetMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.9,
      metalness: 0.05,
      emissive: 0x000000,
      emissiveIntensity: 0.0,
    });
    this.planet = new THREE.Mesh(planetGeom, this.planetMat);
    this.planet.position.set(0, 0, -1500);
    this.scene.add(this.planet);

    const haloGeom = new THREE.SphereGeometry(86, 64, 64);
    this.haloMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: new THREE.Color(0x6cc7ff) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vNormal;
        uniform vec3 uColor;
        void main() {
          float i = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.6);
          gl_FragColor = vec4(uColor, 1.0) * i;
        }
      `,
    });
    this.halo = new THREE.Mesh(haloGeom, this.haloMat);
    this.halo.position.copy(this.planet.position);
    this.scene.add(this.halo);

    // The camera must be in the scene tree for objects parented to it (the
    // cockpit splat) to be traversed by the renderer.
    this.scene.add(this.camera);

    // Cockpit rig — owns view-mode dolly, Artemis GLB, plume, cockpit splat.
    this.rig = new CockpitRig({ scene: this.scene, camera: this.camera });

    // Kick off cockpit splat load. The Artemis cockpit is the only one for
    // now; it's attached to the camera once the splat is initialized.
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

  enter(): void {
    this.rig.attachCockpitToCamera();
    if (this.spark) this.scene.add(this.spark);
  }
  exit(): void {
    this.active = false;
    this.arrivalMode = false;
    // Spark is shared with SurfaceScene; remove so the next scene can claim it.
    if (this.spark && this.spark.parent === this.scene) {
      this.scene.remove(this.spark);
    }
  }

  /** Toggle between cockpit and chase-cam views with the cinematic dolly. */
  toggleView(): void {
    this.rig.toggleView();
  }
  setView(mode: ViewMode, immediate = false): void {
    this.rig.setView(mode, immediate);
  }
  get viewMode(): ViewMode {
    return this.rig.viewMode;
  }

  /** Host-driven smoothed input. Camera + rig + plume react to these. */
  setInput(input: {
    pitch: number;
    yaw: number;
    roll: number;
    throttle: number;
    boost: number;
  }): void {
    this.inputPitch = input.pitch;
    this.inputYaw = input.yaw;
    this.inputRoll = input.roll;
    this.inputThrottle = input.throttle;
    this.inputBoost = input.boost;
  }

  beginTransit(planet: Planet): void {
    this.currentPlanet = planet;
    this.travelTimeSec = 0;
    this.active = true;
    this.arrivalMode = false;
    this.planetModelLoadId += 1;
    this.clearPlanetModel();

    // Color = mid (true planet hue), emissive a darker shade boosted just enough
    // to read through bloom without blowing out highlights.
    this.planetMat.color = new THREE.Color(planet.theme.mid);
    this.planetMat.emissive = new THREE.Color(planet.theme.dark);
    this.planetMat.emissiveIntensity = 0.4;
    this.planetMat.roughness = 0.85;
    this.haloMat.uniforms.uColor.value = new THREE.Color(planet.theme.light);

    this.planet.position.set(0, -10, -1500);
    this.halo.position.copy(this.planet.position);
    this.planet.visible = true;
    this.halo.visible = true;
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);

    // Reset input + rig pose so each transit feels deterministic.
    this.inputPitch = this.inputYaw = this.inputRoll = 0;
    this.inputThrottle = 1;
    this.inputBoost = 0;
    this.rig.setView("cockpit", true);

    if (planet.modelUrl) {
      void this.loadPlanetModel(planet.modelUrl, this.planetModelLoadId);
    }
  }

  beginArrival(): void {
    this.arrivalMode = true;
  }

  skipToArrival(): void {
    this.travelTimeSec = this.travelDurationSec;
  }

  update(delta: number, elapsed: number): void {
    this.starfield.rotation.z = elapsed * 0.02;

    // Throttle multiplies the travel rate. We never let the player stall
    // below 0.6× so the trip always finishes; boost adds a brief 1.5× shove.
    const throttleMul = Math.max(0.6, Math.min(2, this.inputThrottle));
    const boostMul = 1 + this.inputBoost * 0.5;
    const travelRate = throttleMul * boostMul;

    if (this.active && !this.arrivalMode) {
      this.travelTimeSec = Math.min(
        this.travelDurationSec,
        this.travelTimeSec + delta * travelRate,
      );
    }

    const t = this.progress;
    const ease = easeInOutCubic(t);

    // Slide the planet from far -> near while keeping it on the reticle axis.
    const startZ = -1500;
    const endZ = -180;
    this.placeDestination(0, 0, startZ + (endZ - startZ) * ease);
    this.planet.rotation.y += delta * 0.06;
    if (this.planetModel) {
      this.planetModel.rotation.y += delta * 0.06;
    }

    // Camera shake intensity ramps with speed, peaks mid-flight, and gets
    // amplified on boost. We hand this to the rig instead of writing the
    // camera directly so it composes with the view dolly.
    const shakeAmp =
      Math.sin(t * Math.PI) * 0.022 +
      this.inputBoost * 0.025 +
      (this.viewMode === "chase" ? 0.004 : 0.008);
    const shake = (seed: number) =>
      (Math.sin(elapsed * (28 + seed * 4) + seed) +
        Math.sin(elapsed * (61 + seed * 7) + seed * 1.7)) *
      0.5 *
      shakeAmp;

    this._shakeScratch.set(shake(0), shake(1), 0);
    this.rig.setExtraShake(this._shakeScratch);

    // Couple plume to inputs.
    this.rig.setThrottle(this.inputThrottle, this.inputBoost);

    // Drive the cockpit rig (owns camera position/lookAt + view-mode dolly).
    this.rig.update(delta, elapsed);

    // After the rig sets the camera transform, apply player steering on top
    // (additive pitch/yaw/roll). The rig's lookAt has already given us a
    // forward orientation toward the destination; pitch and yaw are small
    // signed offsets that nudge that direction without losing the planet.
    if (!this.arrivalMode) {
      const subtleSwayPitch = noise1D(elapsed * 0.4, 0) * 0.005;
      const subtleSwayYaw = noise1D(elapsed * 0.32, 1) * 0.005;
      this.camera.rotateX(this.inputPitch + subtleSwayPitch);
      this.camera.rotateY(this.inputYaw + subtleSwayYaw);
      this.camera.rotateZ(
        this.inputRoll +
          Math.sin(elapsed * 0.3) * 0.02 * (1 - ease) +
          shake(2) * 0.4,
      );
    }

    // Warp streaks fade out as we slow down at arrival; punch up on boost.
    const warpMat = this.warp.material as THREE.LineBasicMaterial;
    warpMat.opacity = (1.0 - ease * 0.85) * (1 + this.inputBoost * 0.4);
    warpMat.transparent = true;

    // Slide streaks toward the camera
    const speed = (280 * (1 - ease) + 22) * travelRate;
    this.warp.position.z += delta * speed;
    if (this.warp.position.z > 200) this.warp.position.z = 0;

    if (this.arrivalMode) {
      // Once in arrival mode, slowly orbit the planet rather than approach.
      // We bypass the rig and write the camera directly so the orbital
      // composition reads cleanly.
      const a = elapsed * 0.05;
      const r = 220;
      const arrivalPos = this._shakeScratch.set(
        Math.sin(a) * 32,
        6 + Math.sin(elapsed * 0.4) * 0.2,
        Math.cos(a) * 32,
      );
      this.camera.position.copy(arrivalPos);
      this.camera.rotation.set(0, 0, 0);
      this.placeDestination(0, 0, -r);
      this.camera.lookAt(this.planetModel?.position ?? this.planet.position);
    }

    // Avoid an unused-import warning while damp is held in reserve for
    // host-side smoothing of input states.
    void damp;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.rig.dispose();
    this.clearPlanetModel();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) {
        m.forEach((mm) => mm.dispose?.());
      } else {
        m?.dispose?.();
      }
    });
  }

  /* Telemetry exposed to the HUD */

  get progress(): number {
    return Math.min(1, this.travelTimeSec / this.travelDurationSec);
  }

  get velocityKmS(): number {
    if (!this.currentPlanet) return 0;
    const peak = 240; // km/s, fictional
    const t = this.progress;
    // ramp up then ramp down
    const ramp = Math.sin(t * Math.PI);
    return peak * Math.max(0.05, ramp) + 12;
  }

  get etaSec(): number {
    return Math.max(0, this.travelDurationSec - this.travelTimeSec);
  }

  get distanceKm(): number {
    if (!this.currentPlanet) return 0;
    const totalKm = this.currentPlanet.distanceMkm * 1_000_000;
    return totalKm * (1 - this.progress);
  }

  get headingDeg(): number {
    return ((this.travelTimeSec * 12) % 360);
  }

  getDestinationDebugSnapshot(): {
    position: THREE.Vector3;
    screen: THREE.Vector2;
    boundsCenter: THREE.Vector3 | null;
    boundsScreen: THREE.Vector2 | null;
  } {
    const target = this.planetModel ?? this.planet;
    const position = target.position.clone();
    const screen = projectToViewport(position, this.camera);
    const bounds = new THREE.Box3().setFromObject(target);
    const boundsCenter = bounds.isEmpty() ? null : bounds.getCenter(new THREE.Vector3());

    return {
      position,
      screen,
      boundsCenter,
      boundsScreen: boundsCenter ? projectToViewport(boundsCenter, this.camera) : null,
    };
  }

  private async loadPlanetModel(url: string, loadId: number): Promise<void> {
    try {
      const model = await loadNormalizedGltfModel(url, 160);
      if (loadId !== this.planetModelLoadId || this.currentPlanet?.modelUrl !== url) {
        disposeObjectTree(model);
        return;
      }

      this.clearPlanetModel();
      this.planetModel = model;
      this.planetModel.position.copy(this.planet.position);
      this.planetModel.rotation.y = this.planet.rotation.y;
      this.scene.add(this.planetModel);
      this.planet.visible = false;
      this.halo.visible = false;
    } catch (err) {
      console.warn("[FlightScene] failed to load planet GLB", err);
      if (loadId === this.planetModelLoadId) {
        this.planet.visible = true;
        this.halo.visible = true;
      }
    }
  }

  private placeDestination(x: number, y: number, z: number): void {
    this.planet.position.set(x, y, z);
    this.halo.position.copy(this.planet.position);
    if (this.planetModel) {
      this.planetModel.position.copy(this.planet.position);
    }
  }

  private clearPlanetModel(): void {
    if (!this.planetModel) return;
    this.scene.remove(this.planetModel);
    disposeObjectTree(this.planetModel);
    this.planetModel = null;
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function projectToViewport(position: THREE.Vector3, camera: THREE.Camera): THREE.Vector2 {
  const projected = position.clone().project(camera);
  return new THREE.Vector2(
    (projected.x * 0.5 + 0.5) * window.innerWidth,
    (-projected.y * 0.5 + 0.5) * window.innerHeight,
  );
}
