import type { Planet } from "../data/planets";
import { playCue } from "../util/audio";
import { damp } from "../util/feel";
import type { FlightInputSnapshot } from "../scenes/FlightInput";

type MissionPhaseLabel =
  | "liftoff"
  | "cruise"
  | "approach"
  | "touchdown"
  | "landed";

export interface MissionHudTelemetry {
  phase: MissionPhaseLabel;
  /** Altitude in km (positive above ground). */
  altitudeKm: number;
  /** True when reporting altitude above destination, false for Earth AGL. */
  altitudeIsDestination: boolean;
}

interface Args {
  getProgress: () => number;
  getVelocityKmS: () => number;
  getEtaSec: () => number;
  getHeading: () => number;
  getDistanceKm: () => number;
  getTarget: () => Planet | null;
  onArrive: () => void;
  onSkip: () => void;
  /** Subscribe to per-frame flight input. Returns unsubscribe fn. */
  onFlightInput?: (cb: (snap: FlightInputSnapshot) => void) => () => void;
  /** Subscribe to view-mode toggles. Returns unsubscribe fn. */
  onViewToggle?: (cb: (mode: "cockpit" | "chase" | "external") => void) => () => void;
  /** Initial view mode. */
  getViewMode?: () => "cockpit" | "chase" | "external";
  /** Click-to-lock for cockpit mouse-look. */
  onLockRequest?: () => void;
  /** Per-frame mission telemetry (phase + altitude) — optional for legacy flight. */
  getMissionTelemetry?: () => MissionHudTelemetry;
}

/**
 * Drives the in-flight HUD: telemetry readouts, cockpit dashboard, and the
 * view-mode badge. Polls scene-side telemetry every animation frame and
 * smooths the displayed values via `damp` so digits roll instead of flicker.
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

  // Cockpit dashboard nodes
  const dashEl = document.getElementById("cockpit-dash");
  const throttleFill = document.getElementById("cockpit-throttle-fill");
  const throttleNeedle = document.getElementById("cockpit-throttle-needle");
  const throttleVal = document.getElementById("cockpit-throttle-val");
  const boostFill = document.getElementById("cockpit-boost-fill") as
    | (SVGPathElement & { dataset: DOMStringMap })
    | null;
  const boostVal = document.getElementById("cockpit-boost-val");
  const attitudeHorizon = document.getElementById("cockpit-attitude-horizon");

  // View-mode pill
  const viewPill = document.getElementById("flight-view-pill");
  const viewLabel = document.getElementById("flight-view-mode-label");

  // Phase strip
  const phaseStrip = document.getElementById("phase-strip");
  const phaseChips = phaseStrip
    ? Array.from(phaseStrip.querySelectorAll<HTMLElement>("[data-phase]"))
    : [];
  const PHASE_ORDER: MissionPhaseLabel[] = [
    "liftoff",
    "cruise",
    "approach",
    "touchdown",
  ];

  // Altimeter
  const altimeterValue = document.getElementById("altimeter-value");
  const altimeterContext = document.getElementById("altimeter-context");

  // SVG path length for the boost arc — we measure once for accurate fills.
  const boostPathLen = boostFill?.getTotalLength?.() ?? 100;

  let raf = 0;
  let lastTime = 0;
  let lastTarget: Planet | null = null;
  let arrived = false;

  // Smoothed display values — updated each frame from scene telemetry.
  let displayVelocity = 0;
  let lastInput: FlightInputSnapshot = {
    pitch: 0, yaw: 0, roll: 0,
    throttle: 1, boost: 0, boostCharge: 1, boosting: false,
    headLookYaw: 0, headLookPitch: 0,
  };

  const observer = new MutationObserver(() => {
    if (!screen) return;
    const active = screen.classList.contains("is-active");
    if (active) {
      arrived = false;
      lastTarget = args.getTarget();
      if (targetName && lastTarget) targetName.textContent = lastTarget.name.toUpperCase();
      lastTime = 0;
      raf = requestAnimationFrame(loop);
      // Initial view-mode badge.
      applyViewMode(args.getViewMode?.() ?? "cockpit", true);
    } else {
      cancelAnimationFrame(raf);
    }
  });
  if (screen) observer.observe(screen, { attributes: true, attributeFilter: ["class"] });

  function loop(timeMs: number): void {
    const last = lastTime || timeMs;
    const dt = Math.min(0.1, (timeMs - last) / 1000);
    lastTime = timeMs;

    const progress = args.getProgress();
    const velocity = args.getVelocityKmS();
    const eta = args.getEtaSec();
    const heading = args.getHeading();
    const distance = args.getDistanceKm();

    // Smooth velocity readout — no more raw-value flicker.
    displayVelocity = damp(displayVelocity, velocity, 5, dt);

    if (velocityEl) velocityEl.textContent = displayVelocity.toFixed(3).padStart(6, "0");
    if (velocityBar) {
      const segments = Math.max(1, Math.min(7, Math.round((displayVelocity / 14) * 7)));
      velocityBar.dataset.fill = String(segments);
    }
    if (etaEl) etaEl.textContent = formatEta(eta);
    if (headingEl) headingEl.textContent = `${heading.toFixed(0).padStart(3, "0")}°`;
    if (needleEl) needleEl.style.transform = `translateX(-50%) rotate(${heading}deg)`;
    if (distanceEl) distanceEl.textContent = `${formatDistance(distance)} remaining`;
    if (progressEl) progressEl.style.right = `${(1 - progress) * 100}%`;

    // Cockpit dashboard
    updateCockpitDash();

    // Mission HUD bits — phase strip + altimeter. No-op when running the
    // legacy cinematic flight path (which doesn't pass `getMissionTelemetry`).
    if (args.getMissionTelemetry) {
      const t = args.getMissionTelemetry();
      applyPhase(t.phase);
      if (altimeterValue) {
        altimeterValue.textContent = `${formatDistance(t.altitudeKm)}`;
      }
      if (altimeterContext) {
        altimeterContext.textContent = t.altitudeIsDestination
          ? "DEST. AGL"
          : "EARTH AGL";
      }
    }

    if (!arrived && progress >= 1) {
      arrived = true;
      playCue("arrive");
      args.onArrive();
    }

    raf = requestAnimationFrame(loop);
  }

  function updateCockpitDash(): void {
    // Throttle: gauge runs 0..2; midpoint = 1.0 (cruise).
    const throttle = lastInput.throttle;
    const heightPct = Math.max(0, Math.min(100, (throttle / 2) * 100));
    if (throttleFill) throttleFill.style.height = `${heightPct}%`;
    if (throttleNeedle) throttleNeedle.style.bottom = `${heightPct}%`;
    if (throttleVal) {
      throttleVal.textContent = `${Math.round(throttle * 100)}%`;
    }

    // Boost: arc from 0..1.
    if (boostFill) {
      const charge = Math.max(0, Math.min(1, lastInput.boostCharge));
      const offset = boostPathLen * (1 - charge);
      boostFill.style.strokeDasharray = `${boostPathLen} ${boostPathLen}`;
      boostFill.style.strokeDashoffset = `${offset}`;
      boostFill.classList.toggle("is-low", charge < 0.2);
    }
    if (boostVal) {
      boostVal.textContent = `${Math.round(lastInput.boostCharge * 100)}%`;
    }

    // Attitude: rotate horizon by roll, translate by pitch (tunable scale).
    if (attitudeHorizon) {
      const rollDeg = (lastInput.roll * 180) / Math.PI;
      const pitchPx = Math.max(-30, Math.min(30, (lastInput.pitch * 180) / Math.PI));
      attitudeHorizon.setAttribute(
        "transform",
        `translate(0 ${pitchPx}) rotate(${rollDeg})`,
      );
    }
  }

  // --- Phase strip wiring ---
  function applyPhase(phase: MissionPhaseLabel): void {
    if (!phaseStrip || phaseChips.length === 0) return;
    phaseStrip.dataset.phase = phase;
    const activeIdx =
      phase === "landed"
        ? PHASE_ORDER.length // all done
        : PHASE_ORDER.indexOf(phase);
    phaseChips.forEach((chip, i) => {
      chip.classList.toggle("is-active", i === activeIdx);
      chip.classList.toggle("is-done", i < activeIdx);
    });
  }

  // --- View mode wiring ---
  function applyViewMode(mode: "cockpit" | "chase" | "external", instant = false): void {
    if (viewLabel) {
      viewLabel.textContent =
        mode === "cockpit"
          ? "COCKPIT VIEW"
          : mode === "chase"
            ? "CHASE VIEW"
            : "EXTERNAL VIEW";
    }
    if (dashEl) dashEl.dataset.mode = mode;
    if (viewPill && !instant) {
      viewPill.classList.remove("is-flashing");
      void viewPill.offsetWidth; // force reflow to retrigger animation
      viewPill.classList.add("is-flashing");
    }
  }

  const unsubInput =
    args.onFlightInput?.((snap) => {
      lastInput = snap;
    }) ?? (() => {});

  const unsubViewToggle =
    args.onViewToggle?.((mode) => {
      applyViewMode(mode);
    }) ?? (() => {});

  const skip = (): void => {
    playCue("click");
    args.onSkip();
  };
  skipBtn?.addEventListener("click", skip);

  // First click anywhere on the flight screen → request pointer lock so
  // mouse-look becomes available. Locking is opt-in.
  const requestLock = (e: Event): void => {
    if (e.target instanceof HTMLButtonElement) return;
    args.onLockRequest?.();
  };
  screen?.addEventListener("click", requestLock);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    skipBtn?.removeEventListener("click", skip);
    screen?.removeEventListener("click", requestLock);
    unsubInput();
    unsubViewToggle();
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
