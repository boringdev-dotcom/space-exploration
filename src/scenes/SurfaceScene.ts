import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { SplatMesh, type SparkRenderer } from "@sparkjsdev/spark";

import type { SceneSlot } from "./Scene";
import type { Planet } from "../data/planets";

export type SurfaceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

type LockListener = (locked: boolean) => void;

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
  private lockListeners: LockListener[] = [];

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

  // Sprint FOV ramp.
  private readonly normalFov = 70;
  private readonly sprintFov = 78;

  // Marble's viewer drops the camera right at the scan origin. Keep eye
  // height at 0 so we don't lift off above the captured ground plane.
  private readonly eyeHeight = 0;

  // Reusable scratch vectors so we don't allocate per-frame.
  private readonly _camDir = new THREE.Vector3();
  private readonly _moveTarget = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(spark: SparkRenderer, canvas: HTMLCanvasElement) {
    this.spark = spark;
    this.canvas = canvas;

    // Match Spark's reference viewer (examples/viewer/index.html): a single
    // FOV-75 camera with a tight 0.01 near plane so we don't clip our nose.
    // Marble splats fit comfortably inside ~50–100 units, so 1000 far is
    // plenty without burning depth precision.
    this.camera = new THREE.PerspectiveCamera(
      this.normalFov,
      window.innerWidth / window.innerHeight,
      0.01,
      1000,
    );
    this.camera.position.set(0, this.eyeHeight, 0);
    this.scene.add(this.camera);

    // Spark goes straight on the scene — same as the official Spark viewer
    // and the gaussian-splat-character-controller reference. The previous
    // localFrame wrapper was a WebXR-only trick (lifted from the time-travel
    // viewer) and it ends up shifting Spark's view origin away from the
    // camera, which is what made the start pose look "somewhere random".
    this.scene.add(this.spark);

    // No additional lighting or fog: Marble worlds bake their own lighting
    // and atmospheric haze into the splat colours. Adding scene lights or fog
    // would only desaturate / dim the photoreal output.

    this.controls = new PointerLockControls(this.camera, canvas);
    // Match the look feel of the reference character controller.
    this.controls.pointerSpeed = 0.7;

    this.controls.addEventListener("lock", () => this.emitLock(true));
    this.controls.addEventListener("unlock", () => this.emitLock(false));

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  enter(): void {}

  exit(): void {
    if (this.controls.isLocked) {
      this.controls.unlock();
    }
  }

  /** Load the planet's splat. Re-callable for new destinations. */
  async loadPlanet(planet: Planet): Promise<void> {
    this._status = "loading";
    this._progress = 0;

    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
      this.splat = null;
    }

    // Reset the camera onto the scan origin and zero out any leftover motion.
    this.resetCameraPose(planet);
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
    this.horizontalVelocity.set(0, 0, 0);
    this.verticalVelocity = 0;

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

      this.aimCameraAtSplat(splat);

      this._progress = 1;
      this._status = "ready";
    } catch (err) {
      console.error("[SurfaceScene] failed to load splat", err);
      this._status = "error";
    }
  }

  update(delta: number, _elapsed: number): void {
    // Lerp factor based on `velocityXZSmoothing * accelerationTimeGrounded`.
    // The exponent 0.116 is what the reference controller uses to make the
    // response identical regardless of frame rate.
    const lerpFactor =
      1 -
      Math.pow(
        this.velocityXZSmoothing * this.accelerationTimeGrounded,
        0.116,
      );

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
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose?.();
    }
  }

  /* Status surfacing */
  get status(): SurfaceStatus {
    return this._status;
  }
  get progress(): number {
    return this._progress;
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
   * Aim the camera at the densest part of the splat.
   *
   * Marble exports SPZ files where the scan viewpoint is at the splat's local
   * `(0, 0, 0)`, but the captured geometry is heavily biased toward whichever
   * direction the original camera was pointing. Three.js's default camera
   * orientation looks down `-Z`, which (after our OpenCV→OpenGL flip) only
   * happens to coincide with the captured side of the world for some scans
   * — for Europa it points away from the world, leaving ~half the screen
   * black.
   *
   * We use the bounding-box centre of the splat centres as a robust proxy
   * for "the direction with the most stuff", and orient the camera toward
   * that direction so the user spawns looking *into* the world the same way
   * Marble's viewer does by default.
   *
   * Important: `SplatMesh.getBoundingBox()` reports coordinates in the
   * splat's *local* space (it iterates raw centres without applying
   * transforms). Our canonical "right-side-up" rotation (quaternion
   * `(1, 0, 0, 0)`, a 180° flip around X) negates Y and Z, so we rotate the
   * local centre into world space before pointing the camera at it.
   */
  private aimCameraAtSplat(splat: SplatMesh): void {
    let bbox: THREE.Box3 | null = null;
    try {
      bbox = splat.getBoundingBox(true);
    } catch (err) {
      console.warn("[SurfaceScene] splat bbox unavailable, keeping default look", err);
      return;
    }

    if (
      !bbox ||
      !Number.isFinite(bbox.min.x) ||
      !Number.isFinite(bbox.max.x)
    ) {
      console.warn("[SurfaceScene] splat bbox is empty/infinite, keeping default look");
      return;
    }

    const localCenter = bbox.getCenter(new THREE.Vector3());
    const localSize = bbox.getSize(new THREE.Vector3());

    // Convert the local centre into world space using only the splat's
    // rotation (position is 0, scale is 1).
    const worldCenter = localCenter
      .clone()
      .applyQuaternion(splat.quaternion)
      .add(splat.position);

    // Don't pitch the horizon: keep the camera level with the captured
    // ground plane and look horizontally toward the bulk of the geometry.
    // Without this, scans with a low scan origin (Y < 0 in world) would tilt
    // the user's head sharply down and they'd just see splats stacked above.
    const aimTarget = worldCenter.clone();
    aimTarget.y = this.camera.position.y;

    // If the bulk of the world happens to sit on top of the camera (e.g.
    // some weird vertical scan), aimTarget == camera.position and lookAt
    // would produce NaNs. Fall back to a default forward in that case.
    const horizDist = Math.hypot(
      aimTarget.x - this.camera.position.x,
      aimTarget.z - this.camera.position.z,
    );
    if (horizDist < 1e-3) {
      aimTarget.set(
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z - 1,
      );
    }

    this.camera.quaternion.identity();
    this.camera.lookAt(aimTarget);

    console.log(
      "[SurfaceScene] aimed camera — local bbox center:",
      localCenter.toArray().map((v) => v.toFixed(2)),
      "size:",
      localSize.toArray().map((v) => v.toFixed(2)),
      "→ look target (world):",
      aimTarget.toArray().map((v) => v.toFixed(2)),
    );
  }

  private resetCameraPose(planet: Planet): void {
    // Drop the camera onto the scan origin and orient it down -Z. After the
    // splat's OpenCV→OpenGL flip (quaternion 1,0,0,0) this is the direction
    // Marble's viewer faces when the world first opens. A planet can override
    // this with `surfaceLookAt` if its scene has a more cinematic hero view.
    const [lookX, lookY, lookZ] = planet.surfaceLookAt ?? [0, 0, -1];
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.quaternion.identity();
    this.camera.lookAt(lookX, lookY, lookZ);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
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
