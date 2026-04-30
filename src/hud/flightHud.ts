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

/** Telemetry shape consumed by the Primary Flight Display. */
export interface PfdTelemetry {
  speedKmS: number;
  altitudeKm: number;
  altitudeIsDestination: boolean;
  shipPitchDeg: number;
  shipRollDeg: number;
  shipYawDeg: number;
  targetBearingDeg: number;
  targetElevationDeg: number;
  targetInFront: boolean;
  verticalSpeedKmS: number;
  /** 0..2 — same scale as flight dynamics throttle. */
  throttle: number;
  /** 0..1 — boost charge fill. */
  boostCharge: number;
  /** 0..1 — boost held this frame. */
  boost: number;
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
  /** Per-frame PFD telemetry. */
  getPfdTelemetry?: () => PfdTelemetry;
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

  // PFD elements.
  const pfdRoot = document.getElementById("pfd");
  const pfdHorizonRoll = document.getElementById("pfd-horizon-roll") as
    | SVGGElement
    | null;
  const pfdHorizonPitch = document.getElementById("pfd-horizon-pitch") as
    | SVGGElement
    | null;
  const pfdRollPointer = document.getElementById("pfd-roll-pointer") as
    | SVGPolygonElement
    | null;
  const pfdRollArc = document.getElementById("pfd-roll-arc") as
    | SVGGElement
    | null;
  const pfdPitchLadder = document.getElementById("pfd-pitch-ladder") as
    | SVGGElement
    | null;
  const pfdFpv = document.getElementById("pfd-fpv") as SVGGElement | null;
  const pfdAirspeedTicks = document.getElementById("pfd-airspeed-ticks");
  const pfdAirspeedReadout = document.getElementById("pfd-airspeed-readout");
  const pfdAltitudeTicks = document.getElementById("pfd-altitude-ticks");
  const pfdAltitudeReadout = document.getElementById("pfd-altitude-readout");
  const pfdAltitudeLabel = document.getElementById("pfd-altitude-label");
  const pfdVsiReadout = document.getElementById("pfd-vsi-readout");
  const pfdHeadingStrip = document.getElementById("pfd-heading-strip");
  const pfdHeadingBug = document.getElementById("pfd-heading-bug");
  const pfdHeadingReadout = document.getElementById("pfd-heading-readout");
  const pfdThrottleFill = document.getElementById("pfd-throttle-fill");
  const pfdThrottleValue = document.getElementById("pfd-throttle-value");
  const pfdBoostFill = document.getElementById("pfd-boost-fill");
  const pfdBoostValue = document.getElementById("pfd-boost-value");

  // -------------------------------------------------------------------
  // Primary Flight Display constants
  // -------------------------------------------------------------------

  /** PFD layout constants — tuned to fit the SVG viewBox and tape height. */
  const PFD_HORIZON_PX_PER_DEG = 4; // pitch ladder spacing
  const PFD_HEADING_PX_PER_DEG = 10; // heading strip
  const PFD_AIRSPEED_PX_PER_KMS = 18;
  const PFD_AIRSPEED_TICK_KMS = 2; // tick every 2 km/s
  const PFD_ALTITUDE_TICK_KM = 200;
  const PFD_ALTITUDE_PX_PER_KM = 0.18;

  // Build static PFD ticks once on mount.
  initPfdStatics();

  let raf = 0;
  let lastTime = 0;
  let lastTarget: Planet | null = null;

  // Smoothed display velocity — no more raw-value flicker.
  let displayVelocity = 0;
  // Smoothed PFD values so the tape readouts and ladders glide.
  const pfdSmooth = {
    pitchDeg: 0,
    rollDeg: 0,
    yawDeg: 0,
    speedKmS: 0,
    altitudeKm: 0,
    bearingDeg: 0,
    elevationDeg: 0,
    verticalKmS: 0,
    throttle: 1,
    boostCharge: 1,
    boost: 0,
  };
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
      applyViewMode(args.getViewMode?.() ?? "chase", true);
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

    // Drive the PFD if telemetry is wired.
    if (args.getPfdTelemetry) {
      updatePfd(args.getPfdTelemetry(), t.altitudeIsDestination, dt);
    }

    raf = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------
  // Primary Flight Display
  // -------------------------------------------------------------------

  function initPfdStatics(): void {
    if (!pfdRoot) return;

    // Pitch ladder ticks every 10° between -90 and +90.
    if (pfdPitchLadder) {
      const svgNS = "http://www.w3.org/2000/svg";
      const frag = document.createDocumentFragment();
      for (let p = -90; p <= 90; p += 10) {
        if (p === 0) continue;
        const y = -p * PFD_HORIZON_PX_PER_DEG; // pitch up = negative y in SVG
        const len = p % 30 === 0 ? 60 : 32;
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(-len / 2));
        line.setAttribute("x2", String(len / 2));
        line.setAttribute("y1", String(y));
        line.setAttribute("y2", String(y));
        frag.appendChild(line);
        if (p % 30 === 0) {
          const lblL = document.createElementNS(svgNS, "text");
          lblL.setAttribute("x", String(-len / 2 - 6));
          lblL.setAttribute("y", String(y + 3));
          lblL.setAttribute("text-anchor", "end");
          lblL.textContent = String(Math.abs(p));
          frag.appendChild(lblL);
          const lblR = document.createElementNS(svgNS, "text");
          lblR.setAttribute("x", String(len / 2 + 6));
          lblR.setAttribute("y", String(y + 3));
          lblR.setAttribute("text-anchor", "start");
          lblR.textContent = String(Math.abs(p));
          frag.appendChild(lblR);
        }
      }
      pfdPitchLadder.appendChild(frag);
    }

    // Roll arc ticks at -60, -30, 0, 30, 60.
    if (pfdRollArc) {
      const svgNS = "http://www.w3.org/2000/svg";
      const frag = document.createDocumentFragment();
      const radius = 95;
      for (const angle of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
        const isMajor = angle % 30 === 0;
        const inner = isMajor ? radius - 8 : radius - 5;
        const x1 = Math.sin((angle * Math.PI) / 180) * inner;
        const y1 = -Math.cos((angle * Math.PI) / 180) * inner;
        const x2 = Math.sin((angle * Math.PI) / 180) * radius;
        const y2 = -Math.cos((angle * Math.PI) / 180) * radius;
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
        line.setAttribute(
          "stroke",
          isMajor ? "rgba(217, 245, 255, 0.85)" : "rgba(217, 245, 255, 0.5)",
        );
        line.setAttribute("stroke-width", isMajor ? "1.6" : "1");
        frag.appendChild(line);
      }
      pfdRollArc.appendChild(frag);
    }

    // Airspeed ticks: -20..+60 km/s, every 2 km/s.
    if (pfdAirspeedTicks) {
      const frag = document.createDocumentFragment();
      for (let v = 0; v <= 100; v += PFD_AIRSPEED_TICK_KMS) {
        const tick = document.createElement("div");
        tick.className =
          "pfd-tape__tick" + (v % 10 === 0 ? " is-major" : "");
        tick.style.top = `${-v * PFD_AIRSPEED_PX_PER_KMS}px`;
        if (v % 10 === 0) {
          const span = document.createElement("span");
          span.textContent = String(v);
          tick.appendChild(span);
        }
        frag.appendChild(tick);
      }
      pfdAirspeedTicks.appendChild(frag);
    }

    // Altitude ticks: 0..40000 km in PFD_ALTITUDE_TICK_KM steps.
    if (pfdAltitudeTicks) {
      const frag = document.createDocumentFragment();
      for (let a = 0; a <= 40000; a += PFD_ALTITUDE_TICK_KM) {
        const tick = document.createElement("div");
        tick.className =
          "pfd-tape__tick" + (a % 1000 === 0 ? " is-major" : "");
        tick.style.top = `${-a * PFD_ALTITUDE_PX_PER_KM}px`;
        if (a % 1000 === 0) {
          const span = document.createElement("span");
          span.textContent = a >= 1000 ? `${a / 1000}k` : String(a);
          tick.appendChild(span);
        }
        frag.appendChild(tick);
      }
      pfdAltitudeTicks.appendChild(frag);
    }

    // Heading strip: ticks every 10° from -180 to 540 (full wrap range).
    if (pfdHeadingStrip) {
      const frag = document.createDocumentFragment();
      const compass = ["N", "30", "60", "E", "120", "150", "S", "210", "240", "W", "300", "330"];
      for (let h = -180; h <= 540; h += 10) {
        const tick = document.createElement("div");
        tick.className = "pfd-heading__tick" + (h % 30 === 0 ? " is-major" : "");
        tick.style.left = `${h * PFD_HEADING_PX_PER_DEG}px`;
        frag.appendChild(tick);
        if (h % 30 === 0) {
          const lbl = document.createElement("div");
          lbl.className = "pfd-heading__tick-label";
          lbl.style.left = `${h * PFD_HEADING_PX_PER_DEG}px`;
          const idx = ((h % 360) + 360) % 360;
          lbl.textContent = compass[Math.round(idx / 30) % 12];
          frag.appendChild(lbl);
        }
      }
      pfdHeadingStrip.appendChild(frag);
    }
  }

  function updatePfd(p: PfdTelemetry, altIsDest: boolean, dt: number): void {
    if (!pfdRoot) return;
    // Critically-damped smoothing for visible-but-not-laggy motion.
    pfdSmooth.pitchDeg = damp(pfdSmooth.pitchDeg, p.shipPitchDeg, 8, dt);
    pfdSmooth.rollDeg = damp(pfdSmooth.rollDeg, p.shipRollDeg, 9, dt);
    // Heading damps with wrap-aware logic.
    pfdSmooth.yawDeg = dampAngleDeg(pfdSmooth.yawDeg, p.shipYawDeg, 8, dt);
    pfdSmooth.speedKmS = damp(pfdSmooth.speedKmS, p.speedKmS, 6, dt);
    pfdSmooth.altitudeKm = damp(pfdSmooth.altitudeKm, p.altitudeKm, 5, dt);
    pfdSmooth.bearingDeg = dampAngleDeg(
      pfdSmooth.bearingDeg,
      p.targetBearingDeg,
      6,
      dt,
    );
    pfdSmooth.elevationDeg = damp(
      pfdSmooth.elevationDeg,
      p.targetElevationDeg,
      6,
      dt,
    );
    pfdSmooth.verticalKmS = damp(pfdSmooth.verticalKmS, p.verticalSpeedKmS, 5, dt);
    pfdSmooth.throttle = damp(pfdSmooth.throttle, p.throttle, 8, dt);
    pfdSmooth.boostCharge = damp(pfdSmooth.boostCharge, p.boostCharge, 8, dt);
    pfdSmooth.boost = damp(pfdSmooth.boost, p.boost, 12, dt);

    // --- Horizon (pitch + roll) ---
    if (pfdHorizonRoll) {
      pfdHorizonRoll.setAttribute("transform", `rotate(${-pfdSmooth.rollDeg})`);
    }
    if (pfdHorizonPitch) {
      pfdHorizonPitch.setAttribute(
        "transform",
        `translate(0, ${pfdSmooth.pitchDeg * PFD_HORIZON_PX_PER_DEG})`,
      );
    }
    if (pfdRollPointer) {
      pfdRollPointer.setAttribute(
        "transform",
        `rotate(${-pfdSmooth.rollDeg})`,
      );
    }

    // --- Airspeed tape ---
    const speedClamped = Math.max(0, pfdSmooth.speedKmS);
    if (pfdAirspeedTicks) {
      pfdAirspeedTicks.style.transform = `translateY(${
        speedClamped * PFD_AIRSPEED_PX_PER_KMS
      }px)`;
    }
    if (pfdAirspeedReadout) {
      pfdAirspeedReadout.textContent = speedClamped.toFixed(3);
    }

    // --- Altitude tape ---
    const altDisplay = Math.max(0, pfdSmooth.altitudeKm);
    if (pfdAltitudeTicks) {
      pfdAltitudeTicks.style.transform = `translateY(${
        altDisplay * PFD_ALTITUDE_PX_PER_KM
      }px)`;
    }
    if (pfdAltitudeReadout) {
      pfdAltitudeReadout.textContent = formatDistance(altDisplay);
    }
    if (pfdAltitudeLabel) {
      pfdAltitudeLabel.textContent = altIsDest ? "DEST. AGL" : "EARTH AGL";
    }
    if (pfdVsiReadout) {
      const vs = pfdSmooth.verticalKmS;
      const sign = vs >= 0 ? "+" : "";
      pfdVsiReadout.textContent = `VS ${sign}${vs.toFixed(2)} km/s`;
    }

    // --- Heading strip + readout ---
    if (pfdHeadingStrip) {
      pfdHeadingStrip.style.transform = `translateX(${
        -pfdSmooth.yawDeg * PFD_HEADING_PX_PER_DEG
      }px)`;
    }
    if (pfdHeadingReadout) {
      const yawNorm = ((pfdSmooth.yawDeg % 360) + 360) % 360;
      pfdHeadingReadout.textContent = `${Math.round(yawNorm).toString().padStart(3, "0")}°`;
    }
    // Target bearing bug — relative offset from own heading, clamped to viewport.
    if (pfdHeadingBug) {
      let bearing = pfdSmooth.bearingDeg;
      // Clamp to ±60° so the bug doesn't fly off the visible portion.
      const visible = Math.abs(bearing) <= 90 && p.targetInFront;
      bearing = Math.max(-60, Math.min(60, bearing));
      pfdHeadingBug.dataset.hidden = visible ? "false" : "true";
      pfdHeadingBug.style.transform = `translateX(calc(-50% + ${
        bearing * PFD_HEADING_PX_PER_DEG
      }px))`;
    }

    // --- Flight Path Vector marker ---
    if (pfdFpv) {
      // Project velocity vector into the artificial horizon: bearing-from-own-heading
      // is the camera-frame yaw, elevation is camera-frame pitch.
      // We compute this from the ship's own velocity vs. its own forward,
      // but we don't have that data here directly — instead, a reasonable
      // proxy: when we're moving forward (target bearing close to 0 along
      // velocity direction), keep the FPV near center; offset by ship pitch.
      // For now, hide the FPV if speed is too low to be meaningful.
      if (speedClamped < 0.3) {
        pfdFpv.style.display = "none";
      } else {
        pfdFpv.style.display = "";
        // Offset matches the pitch ladder so the FPV lies on the velocity
        // vector when ship-forward equals velocity direction.
        // We approximate: FPV pitch offset = -shipPitchDeg (so the marker
        // sticks to the horizon when nose is on horizon and we're cruising
        // straight). Actual prograde drift is small at our scale.
        pfdFpv.setAttribute(
          "transform",
          `translate(0, ${pfdSmooth.pitchDeg * PFD_HORIZON_PX_PER_DEG * 0.4})`,
        );
      }
    }

    // --- Throttle + boost gauges ---
    if (pfdThrottleFill) {
      const pct = Math.max(0, Math.min(100, (pfdSmooth.throttle / 2) * 100));
      pfdThrottleFill.style.width = `${pct}%`;
    }
    if (pfdThrottleValue) {
      pfdThrottleValue.textContent = `${Math.round((pfdSmooth.throttle / 2) * 100)}%`;
    }
    if (pfdBoostFill) {
      const pct = Math.max(0, Math.min(100, pfdSmooth.boostCharge * 100));
      pfdBoostFill.style.width = `${pct}%`;
    }
    if (pfdBoostValue) {
      pfdBoostValue.textContent = `${Math.round(pfdSmooth.boostCharge * 100)}%`;
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
    if (viewPill && !instant) {
      viewPill.classList.remove("is-flashing");
      void viewPill.offsetWidth; // force reflow to retrigger animation
      viewPill.classList.add("is-flashing");
    }
  }

  // Subscriptions are still accepted (so SceneManager wiring keeps working);
  // we ignore the input snapshot in this HUD (PFD pulls from getPfdTelemetry).
  void ({} as FlightInputSnapshot);
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

  // Help + PFD toggle wiring -------------------------------------------
  const helpToggleBtn = document.getElementById(
    "flight-help-toggle",
  ) as HTMLButtonElement | null;
  const pfdToggleBtn = document.getElementById(
    "flight-pfd-toggle",
  ) as HTMLButtonElement | null;

  let helpVisible = false;
  function setHelpVisible(visible: boolean): void {
    helpVisible = visible;
    if (helpOverlay) {
      helpOverlay.dataset.visible = visible ? "true" : "false";
      helpOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (helpToggleBtn) helpToggleBtn.dataset.active = visible ? "true" : "false";
  }

  let pfdVisible = false;
  function setPfdVisible(visible: boolean): void {
    pfdVisible = visible;
    if (pfdRoot) {
      pfdRoot.dataset.visible = visible ? "true" : "false";
      pfdRoot.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (pfdToggleBtn) pfdToggleBtn.dataset.active = visible ? "true" : "false";
  }

  const unsubHelp =
    args.onHelpToggle?.(() => {
      setHelpVisible(!helpVisible);
    }) ?? (() => {});

  const onHelpBtnClick = (e: MouseEvent): void => {
    e.stopPropagation();
    setHelpVisible(!helpVisible);
  };
  const onPfdBtnClick = (e: MouseEvent): void => {
    e.stopPropagation();
    setPfdVisible(!pfdVisible);
  };
  const helpCloseBtn = document.getElementById(
    "flight-help-close",
  ) as HTMLButtonElement | null;
  const onHelpCloseClick = (e: MouseEvent): void => {
    e.stopPropagation();
    setHelpVisible(false);
  };
  helpToggleBtn?.addEventListener("click", onHelpBtnClick);
  pfdToggleBtn?.addEventListener("click", onPfdBtnClick);
  helpCloseBtn?.addEventListener("click", onHelpCloseClick);

  const onPfdKey = (e: KeyboardEvent): void => {
    if (
      e.code === "KeyP" &&
      !e.repeat &&
      screen?.classList.contains("is-active")
    ) {
      setPfdVisible(!pfdVisible);
    }
  };
  window.addEventListener("keydown", onPfdKey);

  // Engage overlay (just a tutorial hint card now — click-and-drag
  // doesn't gate input). Show on activation, auto-hide after 4s or on
  // first deliberate input.
  let engageHideTimer: number | null = null;
  function setEngageVisible(visible: boolean): void {
    if (!engageOverlay) return;
    engageOverlay.dataset.visible = visible ? "true" : "false";
    engageOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
    if (engageHideTimer !== null) {
      window.clearTimeout(engageHideTimer);
      engageHideTimer = null;
    }
    if (visible) {
      engageHideTimer = window.setTimeout(() => setEngageVisible(false), 4500);
    }
  }
  // Hide the hint as soon as the player drags or presses a flight key.
  // We piggy-back on the lock-change event (now drag-state event) and
  // dismiss on first activation.
  const unsubLock =
    args.onPointerLockChange?.((locked) => {
      if (locked) setEngageVisible(false);
    }) ?? (() => {});

  // Reset visibility cleanly when leaving the flight screen, and show
  // the engage hint card on first activation per session.
  let firstActivationDone = false;
  const screenActiveObserver = new MutationObserver(() => {
    if (!screen) return;
    if (screen.classList.contains("is-active")) {
      if (!firstActivationDone) {
        firstActivationDone = true;
        setEngageVisible(true);
      }
    } else {
      setHelpVisible(false);
      setPfdVisible(false);
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
    if (engageHideTimer !== null) window.clearTimeout(engageHideTimer);
    screen?.removeEventListener("click", requestLock);
    skipBtn?.removeEventListener("click", onSkipClick);
    helpToggleBtn?.removeEventListener("click", onHelpBtnClick);
    pfdToggleBtn?.removeEventListener("click", onPfdBtnClick);
    helpCloseBtn?.removeEventListener("click", onHelpCloseClick);
    window.removeEventListener("keydown", onPfdKey);
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

/** Damp a degrees-valued angle with wrap-aware shortest-arc handling. */
function dampAngleDeg(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  let delta = target - current;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return current + delta * (1 - Math.exp(-lambda * dt));
}
