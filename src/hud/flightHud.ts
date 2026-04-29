import type { Planet } from "../data/planets";
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
  getVelocityKmS: () => number;
  getDistanceKm: () => number;
  getTarget: () => Planet | null;
  /** Subscribe to per-frame flight input. Returns unsubscribe fn. */
  onFlightInput?: (cb: (snap: FlightInputSnapshot) => void) => () => void;
  /** Subscribe to view-mode toggles. Returns unsubscribe fn. */
  onViewToggle?: (cb: (mode: "cockpit" | "chase" | "external") => void) => () => void;
  /** Initial view mode. */
  getViewMode?: () => "cockpit" | "chase" | "external";
  /** Click-to-lock for cockpit mouse-look. */
  onLockRequest?: () => void;
  /** Per-frame mission telemetry (phase + altitude). */
  getMissionTelemetry: () => MissionHudTelemetry;
}

/**
 * Drives the minimal in-flight HUD: a single quiet readout panel with
 * destination, velocity, altitude and range, plus the top-center view-mode
 * pill and mission phase strip. The in-flight experience is meant to read
 * like Microsoft Flight Simulator — most of the visual storytelling lives
 * in the 3D scene, not the HUD chrome.
 */
export function mountFlightHud(args: Args): () => void {
  const targetName = document.getElementById("flight-target-name");
  const velocityEl = document.getElementById("flight-velocity");
  const distanceEl = document.getElementById("flight-distance");
  const screen = document.getElementById("screen-flight");

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

  // Altimeter (now part of the unified readout panel).
  const altimeterValue = document.getElementById("altimeter-value");
  const altimeterContext = document.getElementById("altimeter-context");

  let raf = 0;
  let lastTime = 0;
  let lastTarget: Planet | null = null;

  // Smoothed display velocity — no more raw-value flicker.
  let displayVelocity = 0;
  // We don't actually need lastInput today (no cockpit-dash), but we still
  // accept the subscription so the SceneManager's existing wiring stays
  // sane and so future debug overlays can surface the snapshot.
  void ({} as FlightInputSnapshot);

  const observer = new MutationObserver(() => {
    if (!screen) return;
    const active = screen.classList.contains("is-active");
    if (active) {
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

    const velocity = args.getVelocityKmS();
    const distance = args.getDistanceKm();

    displayVelocity = damp(displayVelocity, velocity, 5, dt);

    if (velocityEl) velocityEl.textContent = displayVelocity.toFixed(3).padStart(7, "0");
    if (distanceEl) distanceEl.textContent = formatDistance(distance);

    // Phase strip + altimeter context.
    const t = args.getMissionTelemetry();
    applyPhase(t.phase);
    if (altimeterValue) altimeterValue.textContent = formatDistance(t.altitudeKm);
    if (altimeterContext) {
      altimeterContext.textContent = t.altitudeIsDestination
        ? "DEST. AGL"
        : "EARTH AGL";
    }

    raf = requestAnimationFrame(loop);
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
    if (viewPill && !instant) {
      viewPill.classList.remove("is-flashing");
      void viewPill.offsetWidth; // force reflow to retrigger animation
      viewPill.classList.add("is-flashing");
    }
  }

  // Subscriptions are still accepted (so SceneManager wiring keeps working);
  // we ignore the input snapshot now that the cockpit dash is gone.
  const unsubInput = args.onFlightInput?.(() => {}) ?? (() => {});

  const unsubViewToggle =
    args.onViewToggle?.((mode) => {
      applyViewMode(mode);
    }) ?? (() => {});

  // First click anywhere on the flight screen → request pointer lock so
  // mouse-look becomes available. Locking is opt-in (browsers may already
  // grant it from the launch button gesture; this is the fallback path).
  const requestLock = (e: Event): void => {
    if (e.target instanceof HTMLButtonElement) return;
    args.onLockRequest?.();
  };
  screen?.addEventListener("click", requestLock);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    screen?.removeEventListener("click", requestLock);
    unsubInput();
    unsubViewToggle();
  };
}

function formatDistance(km: number): string {
  if (km > 1_000_000) return `${(km / 1_000_000).toFixed(2)} M km`;
  if (km > 1_000) return `${(km / 1_000).toFixed(0)} k km`;
  return `${km.toFixed(0)} km`;
}
