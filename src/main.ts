import {
  ARTEMIS_ROCKET_GLB_URL,
  COCKPIT_GLB_URL,
  EARTH_GLB_URL,
} from "./data/assetUrls";
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
  void preloadGltf(COCKPIT_GLB_URL);

  const manager = new SceneManager(canvas);
  mountDebugHud({ manager });

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

  // Convenience URL shortcuts for manual testing + screen recordings:
  //   ?surface=1   → jump straight to the Mars surface scene
  //   ?surface=1&taxi=1 → also auto-summon the robotaxi once ready
  // Available in both dev and the preview/production builds — the
  // shortcut just calls the existing SceneManager helper, so it can't do
  // anything a user couldn't already do via the in-game UI.
  const params = new URLSearchParams(window.location.search);
  if (params.has("surface")) {
    window.setTimeout(() => {
      try {
        manager.forceSurfaceForDebug();
      } catch (err) {
        console.warn("[main] ?surface URL shortcut failed", err);
      }
    }, 50);
    if (params.get("taxi") === "1") {
      const trySummon = (): void => {
        if (manager.surface.status === "ready") {
          manager.surface.requestRobotaxi();
        } else {
          window.setTimeout(trySummon, 300);
        }
      };
      window.setTimeout(trySummon, 800);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
