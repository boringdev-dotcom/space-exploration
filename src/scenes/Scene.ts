import type * as THREE from "three";

/**
 * Common interface for the three swappable 3D scenes (launch, flight, surface).
 * Each scene owns its own THREE.Scene and Camera and reports them to the renderer.
 */
export interface SceneSlot {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;

  enter(): void;
  exit(): void;
  update(deltaSec: number, elapsedSec: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
