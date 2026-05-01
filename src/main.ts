import { ARTEMIS_ROCKET_GLB_URL, EARTH_GLB_URL } from "./data/assetUrls";
import { SceneManager } from "./scenes/SceneManager";
import { mountDebugHud } from "./hud/debugHud";
import { unlockAudio } from "./util/audio";
import { preloadGltf } from "./util/gltfModel";

function bootstrap(): void {
  const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("Missing #stage canvas");
    return;
  }

  // Warm the largest GLBs in parallel with WebGL init so hangar + mission
  // share one cached parse (see gltfModel.ts) instead of duplicate work.
  void preloadGltf(ARTEMIS_ROCKET_GLB_URL);
  void preloadGltf(EARTH_GLB_URL);

  const manager = new SceneManager(canvas);
  mountDebugHud({ manager });

  // Dev-only URL hook: `?surface=europa` jumps straight to the surface
  // scene for the given planet id, skipping hangar/launch/flight. Handy
  // for iterating on the surface scene or its procedural fallback without
  // flying the whole mission each time. Gated behind `import.meta.env.DEV`
  // so it never ships in production builds.
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(window.location.search);
    const surfaceId = params.get("surface");
    if (surfaceId) {
      void import("./data/planets").then(({ getPlanet }) => {
        try {
          manager.forceSurfaceForDebug(getPlanet(surfaceId));
        } catch (err) {
          console.warn("[main] ?surface=", surfaceId, err);
        }
      });
    }
  }

  // Unlock audio on first user interaction (browsers block autoplay).
  const unlock = (): void => {
    unlockAudio();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  // Expose for debugging in dev.
  if (import.meta.env.DEV) {
    (window as unknown as { __manager: SceneManager }).__manager = manager;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
