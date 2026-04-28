import type { Planet } from "../data/planets";
import { playCue } from "../util/audio";

interface Args {
  getProgress: () => number;
  getVelocityKmS: () => number;
  getEtaSec: () => number;
  getHeading: () => number;
  getDistanceKm: () => number;
  getTarget: () => Planet | null;
  onArrive: () => void;
  onSkip: () => void;
}

/**
 * Drives the IN-FLIGHT NAVIGATION HUD: compass needle, velocity readout,
 * progress bar, ETA. Polls scene-side telemetry every animation frame.
 */
export function mountFlightHud(args: Args): () => void {
  const targetName = document.getElementById("flight-target-name");
  const velocityEl = document.getElementById("flight-velocity");
  const velocityBar = document.getElementById("flight-velocity-bar");
  const etaEl = document.getElementById("flight-eta");
  const headingEl = document.getElementById("flight-heading");
  const needleEl = document.getElementById("flight-needle");
  const distanceEl = document.getElementById("flight-distance");
  const progressEl = document.getElementById("flight-progress");
  const skipBtn = document.getElementById("flight-skip-btn") as HTMLButtonElement | null;
  const screen = document.getElementById("screen-flight");

  let raf = 0;
  let lastTarget: Planet | null = null;
  let arrived = false;

  const observer = new MutationObserver(() => {
    if (!screen) return;
    const active = screen.classList.contains("is-active");
    if (active) {
      arrived = false;
      lastTarget = args.getTarget();
      if (targetName && lastTarget) targetName.textContent = lastTarget.name.toUpperCase();
      raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(raf);
    }
  });
  if (screen) observer.observe(screen, { attributes: true, attributeFilter: ["class"] });

  function loop(): void {
    const progress = args.getProgress();
    const velocity = args.getVelocityKmS();
    const eta = args.getEtaSec();
    const heading = args.getHeading();
    const distance = args.getDistanceKm();

    if (velocityEl) velocityEl.textContent = velocity.toFixed(3).padStart(6, "0");
    if (velocityBar) {
      // Map velocity onto 7-segment scale (0..escapeV ≈ 14 km/s).
      const segments = Math.max(1, Math.min(7, Math.round((velocity / 14) * 7)));
      velocityBar.dataset.fill = String(segments);
    }
    if (etaEl) etaEl.textContent = formatEta(eta);
    if (headingEl) headingEl.textContent = `${heading.toFixed(0).padStart(3, "0")}°`;
    if (needleEl) needleEl.style.transform = `translateX(-50%) rotate(${heading}deg)`;
    if (distanceEl) distanceEl.textContent = `${formatDistance(distance)} remaining`;
    if (progressEl) progressEl.style.right = `${(1 - progress) * 100}%`;

    if (!arrived && progress >= 1) {
      arrived = true;
      playCue("arrive");
      args.onArrive();
    }

    raf = requestAnimationFrame(loop);
  }

  const skip = (): void => {
    playCue("click");
    args.onSkip();
  };
  skipBtn?.addEventListener("click", skip);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    skipBtn?.removeEventListener("click", skip);
  };
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatDistance(km: number): string {
  if (km > 1_000_000) return `${(km / 1_000_000).toFixed(2)} M km`;
  if (km > 1_000) return `${(km / 1_000).toFixed(0)} k km`;
  return `${km.toFixed(0)} km`;
}
