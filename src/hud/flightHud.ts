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

export type ControlMode = "auto" | "manual" | "free-fly";

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
  /** Player clicked "Skip to Landing". */
  onSkipToLanding?: () => void;
  /** Subscribe to control-mode changes (auto / manual / free-fly). */
  onControlModeChange?: (cb: (mode: ControlMode) => void) => () => void;
  /** Initial control mode (for first-paint of the pill). */
  getControlMode?: () => ControlMode;
  /** Subscribe to "H" key toggle. */
  onHelpToggle?: (cb: () => void) => () => void;
  /** Subscribe to pointer-lock state changes (for engage overlay). */
  onPointerLockChange?: (cb: (locked: boolean) => void) => () => void;
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

  // Control-mode pill
  const controlPill = document.getElementById("flight-control-mode-pill");
  const controlLabel = document.getElementById("flight-control-mode-label");

  // Help + engage overlays
  const helpOverlay = document.getElementById("flight-help-overlay");
  const engageOverlay = document.getElementById("flight-engage-overlay");

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

  // Skip-to-landing button.
  const skipBtn = document.getElementById(
    "flight-skip-btn",
  ) as HTMLButtonElement | null;
  const onSkipClick = (e: MouseEvent): void => {
    e.stopPropagation();
    args.onSkipToLanding?.();
  };
  skipBtn?.addEventListener("click", onSkipClick);

  // Control-mode pill wiring -------------------------------------------
  let currentControlMode: ControlMode = args.getControlMode?.() ?? "auto";
  applyControlMode(currentControlMode, true);
  const unsubControlMode =
    args.onControlModeChange?.((mode) => {
      currentControlMode = mode;
      applyControlMode(mode);
      // Free-fly hides the skip pill (no destination to skip to).
      if (skipBtn) {
        skipBtn.dataset.disabled = mode === "free-fly" ? "true" : "false";
      }
      if (phaseStrip) {
        phaseStrip.dataset.paused = mode === "free-fly" ? "true" : "false";
      }
    }) ?? (() => {});

  function applyControlMode(mode: ControlMode, instant = false): void {
    if (controlLabel) {
      controlLabel.textContent =
        mode === "auto"
          ? "AUTOPILOT"
          : mode === "manual"
            ? "MANUAL FLIGHT"
            : "FREE FLIGHT";
    }
    if (controlPill) {
      controlPill.dataset.mode = mode;
      if (!instant) {
        controlPill.classList.remove("is-flashing");
        void controlPill.offsetWidth;
        controlPill.classList.add("is-flashing");
      }
    }
  }

  // Help overlay wiring ------------------------------------------------
  let helpVisible = false;
  let firstShowTimer: number | null = null;
  function setHelpVisible(visible: boolean): void {
    helpVisible = visible;
    if (helpOverlay) {
      helpOverlay.dataset.visible = visible ? "true" : "false";
      helpOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (firstShowTimer !== null) {
      window.clearTimeout(firstShowTimer);
      firstShowTimer = null;
    }
  }
  const unsubHelp =
    args.onHelpToggle?.(() => {
      setHelpVisible(!helpVisible);
    }) ?? (() => {});

  // Auto-show help for ~5s the first time the player enters the flight
  // screen so they discover the binding overlay without reading docs.
  let firstActivationDone = false;
  function maybeAutoShowHelp(): void {
    if (firstActivationDone) return;
    firstActivationDone = true;
    setHelpVisible(true);
    firstShowTimer = window.setTimeout(() => {
      if (helpVisible) setHelpVisible(false);
      firstShowTimer = null;
    }, 5500);
  }

  // Engage overlay wiring ----------------------------------------------
  function setEngageVisible(visible: boolean): void {
    if (!engageOverlay) return;
    engageOverlay.dataset.visible = visible ? "true" : "false";
    engageOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  // Default to visible until a lock event tells us otherwise. Browsers may
  // already auto-lock from the launch button gesture; the lock-change
  // callback will hide us within a frame in that case.
  setEngageVisible(true);
  const unsubLock =
    args.onPointerLockChange?.((locked) => {
      setEngageVisible(!locked);
    }) ?? (() => {});

  // Hook the existing screen-active observer so we auto-show help on
  // first activation and reset visibility cleanly.
  const screenActiveObserver = new MutationObserver(() => {
    if (!screen) return;
    if (screen.classList.contains("is-active")) {
      maybeAutoShowHelp();
    } else {
      setHelpVisible(false);
      setEngageVisible(false);
    }
  });
  if (screen) {
    screenActiveObserver.observe(screen, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    screenActiveObserver.disconnect();
    if (firstShowTimer !== null) window.clearTimeout(firstShowTimer);
    screen?.removeEventListener("click", requestLock);
    skipBtn?.removeEventListener("click", onSkipClick);
    unsubInput();
    unsubViewToggle();
    unsubControlMode();
    unsubHelp();
    unsubLock();
  };
}

function formatDistance(km: number): string {
  if (km > 1_000_000) return `${(km / 1_000_000).toFixed(2)} M km`;
  if (km > 1_000) return `${(km / 1_000).toFixed(0)} k km`;
  return `${km.toFixed(0)} km`;
}
