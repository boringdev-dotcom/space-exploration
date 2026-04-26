import { SceneManager } from "./scenes/SceneManager";
import { unlockAudio } from "./util/audio";

function bootstrap(): void {
  const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("Missing #stage canvas");
    return;
  }

  const loader = document.getElementById("loader");
  const loaderMessage = document.getElementById("loader-message");

  const phases = [
    "INITIALIZING SYSTEMS",
    "ALIGNING TELEMETRY",
    "WARMING UP REACTOR",
    "BOOTING NAVIGATION",
  ];
  let phaseIdx = 0;
  const phaseTimer = window.setInterval(() => {
    phaseIdx = (phaseIdx + 1) % phases.length;
    if (loaderMessage) loaderMessage.textContent = phases[phaseIdx];
  }, 600);

  const manager = new SceneManager(canvas);

  // Unlock audio on first user interaction (browsers block autoplay).
  const unlock = (): void => {
    unlockAudio();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  // Hide the loader after a brief moment so the WebGL pipeline can warm up.
  window.setTimeout(() => {
    window.clearInterval(phaseTimer);
    loader?.classList.add("is-hidden");
  }, 1500);

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
