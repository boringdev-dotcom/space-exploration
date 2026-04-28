import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { SceneSlot } from "./Scene";
import { createStarfield } from "../util/starfield";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";

const ROCKET_MODEL_URL = "/models/rockets/artemis_ii_-_space_launch_system_sls.glb";

export class HangarScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  status = "LOADING ROCKET";

  private readonly controls: OrbitControls;
  private readonly starfield: THREE.Points;
  private readonly rocketPivot = new THREE.Group();
  private readonly beaconLights: THREE.PointLight[] = [];
  private rocket: THREE.Group | null = null;
  private loadStarted = false;
  private disposed = false;
  private idleTimerSec = 0;
  private interacted = false;

  constructor(domElement: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(
      42,
      window.innerWidth / window.innerHeight,
      0.05,
      1200,
    );
    this.camera.position.set(0.12, 2.15, 9.8);

    this.scene.fog = new THREE.FogExp2(0x030508, 0.036);

    this.starfield = createStarfield({ count: 2600, radius: 480 });
    this.scene.add(this.starfield);

    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x10141c, 0.48));
    this.scene.add(new THREE.AmbientLight(0x6f87aa, 0.12));

    const key = new THREE.DirectionalLight(0xffdfbd, 0.85);
    key.position.set(4.8, 7.2, 5.5);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8fdcff, 0.78);
    rim.position.set(-5.5, 3.2, -4.4);
    this.scene.add(rim);

    const focusTarget = new THREE.Object3D();
    focusTarget.position.set(0, 2.25, 0);
    this.scene.add(focusTarget);

    const overhead = new THREE.SpotLight(0xfff2dc, 3.1, 18, Math.PI / 7, 0.72, 1.15);
    overhead.position.set(0, 7.8, 3.2);
    overhead.target = focusTarget;
    this.scene.add(overhead);

    const portFill = new THREE.SpotLight(0x9fdcff, 1.15, 14, Math.PI / 6, 0.8, 1.2);
    portFill.position.set(-4.6, 4.2, 3.8);
    portFill.target = focusTarget;
    this.scene.add(portFill);

    const warmEdge = new THREE.SpotLight(0xffc69b, 0.95, 13, Math.PI / 6.5, 0.74, 1.2);
    warmEdge.position.set(4.2, 3.5, -3.6);
    warmEdge.target = focusTarget;
    this.scene.add(warmEdge);

    this.scene.add(this.buildHangarPad());
    this.scene.add(this.rocketPivot);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.target.set(0, 2.05, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = true;
    this.controls.minDistance = 5.6;
    this.controls.maxDistance = 15.5;
    this.controls.rotateSpeed = 0.58;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.38;
    this.controls.addEventListener("start", () => {
      this.interacted = true;
      this.idleTimerSec = 0;
      this.controls.autoRotate = false;
    });
    this.controls.update();

    void this.loadRocket();
  }

  enter(): void {
    this.controls.enabled = true;
    if (!this.rocket && !this.loadStarted) {
      void this.loadRocket();
    }
  }

  exit(): void {
    this.controls.enabled = false;
  }

  update(deltaSec: number, elapsedSec: number): void {
    this.starfield.rotation.y += deltaSec * 0.002;

    this.idleTimerSec += deltaSec;
    if (this.interacted && this.idleTimerSec > 3.8) {
      this.controls.autoRotate = true;
    }

    this.rocketPivot.position.y = Math.sin(elapsedSec * 1.2) * 0.035;
    this.rocketPivot.rotation.y += deltaSec * 0.035;

    this.beaconLights.forEach((light, idx) => {
      light.intensity = 0.32 + Math.sin(elapsedSec * 2.2 + idx * 1.7) * 0.08;
    });

    this.controls.update();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.controls.dispose();
    this.scene.traverse((obj) => {
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

  private async loadRocket(): Promise<void> {
    this.loadStarted = true;
    this.status = "LOADING ROCKET";

    try {
      const rocket = await loadNormalizedGltfModel(ROCKET_MODEL_URL, 4.75);
      if (this.disposed) {
        disposeObjectTree(rocket);
        return;
      }

      this.rocket = rocket;
      this.rocket.position.set(0, 2.42, 0);
      this.rocket.rotation.set(0, -0.28, 0);
      this.rocketPivot.add(this.rocket);
      this.status = "ROCKET READY";
    } catch (err) {
      this.status = "MODEL OFFLINE";
      console.warn("[HangarScene] failed to load rocket GLB", err);
    }
  }

  private buildHangarPad(): THREE.Group {
    const group = new THREE.Group();

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(5.4, 96),
      new THREE.MeshStandardMaterial({
        color: 0x121821,
        metalness: 0.45,
        roughness: 0.48,
        emissive: 0x06121a,
        emissiveIntensity: 0.16,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    group.add(floor);

    const padRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.18, 0.018, 8, 128),
      new THREE.MeshBasicMaterial({
        color: 0x4cd6ff,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
      }),
    );
    padRing.rotation.x = Math.PI / 2;
    padRing.position.y = 0.015;
    group.add(padRing);

    const outerRing = padRing.clone();
    outerRing.scale.setScalar(1.78);
    outerRing.material = new THREE.MeshBasicMaterial({
      color: 0xffb693,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
    });
    group.add(outerRing);

    const grid = new THREE.GridHelper(10.5, 32, 0x4cd6ff, 0x243341);
    grid.position.y = 0.005;
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.13;
    group.add(grid);

    const mastMat = new THREE.MeshStandardMaterial({
      color: 0x18222d,
      metalness: 0.8,
      roughness: 0.32,
      emissive: 0x03131a,
      emissiveIntensity: 0.12,
    });
    const lightMat = new THREE.MeshBasicMaterial({
      color: 0x4cd6ff,
      transparent: true,
      opacity: 0.42,
    });

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x = Math.cos(angle) * 3.15;
      const z = Math.sin(angle) * 3.15;

      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.55, 0.08), mastMat);
      mast.position.set(x, 0.78, z);
      group.add(mast);

      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), lightMat);
      lamp.position.set(x, 1.58, z);
      group.add(lamp);

      const light = new THREE.PointLight(0x4cd6ff, 0.35, 4.4);
      light.position.copy(lamp.position);
      this.beaconLights.push(light);
      group.add(light);
    }

    return group;
  }
}
