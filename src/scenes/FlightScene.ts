import * as THREE from "three";

import type { SceneSlot } from "./Scene";
import { createStarfield, createWarpStreaks } from "../util/starfield";
import type { Planet } from "../data/planets";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";

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

  constructor() {
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
  }

  enter(): void {}
  exit(): void {
    this.active = false;
    this.arrivalMode = false;
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

    if (this.active && !this.arrivalMode) {
      this.travelTimeSec = Math.min(
        this.travelDurationSec,
        this.travelTimeSec + delta,
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

    // Camera shake intensity ramps with speed, peaks mid-flight.
    const shakeAmp = Math.sin(t * Math.PI) * 0.022;
    const shake = (seed: number) =>
      (Math.sin(elapsed * (28 + seed * 4) + seed) +
        Math.sin(elapsed * (61 + seed * 7) + seed * 1.7)) *
      0.5 *
      shakeAmp;

    this.camera.position.x = shake(0);
    this.camera.position.y = shake(1);
    this.camera.position.z = 0;
    this.camera.rotation.z = Math.sin(elapsed * 0.3) * 0.02 * (1 - ease) + shake(2) * 0.4;

    // Warp streaks fade out as we slow down at arrival
    const warpMat = this.warp.material as THREE.LineBasicMaterial;
    warpMat.opacity = 1.0 - ease * 0.85;
    warpMat.transparent = true;

    // Slide streaks toward the camera
    const speed = 280 * (1 - ease) + 22;
    this.warp.position.z += delta * speed;
    if (this.warp.position.z > 200) this.warp.position.z = 0;

    if (this.arrivalMode) {
      // Once in arrival mode, slowly orbit the planet rather than approach.
      const a = elapsed * 0.05;
      const r = 220;
      this.camera.position.x = Math.sin(a) * 32;
      this.camera.position.y = 6 + Math.sin(elapsed * 0.4) * 0.2;
      this.camera.position.z = Math.cos(a) * 32;
      this.camera.rotation.set(0, 0, 0);
      this.placeDestination(0, 0, -r);
      this.camera.lookAt(this.planetModel?.position ?? this.planet.position);
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
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
