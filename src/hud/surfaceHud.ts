import { PLANETS, type Planet } from "../data/planets";
import type {
  SurfaceRocketInteractionSnapshot,
  SurfaceStatus,
} from "../scenes/SurfaceScene";
import { playCue } from "../util/audio";

interface Args {
  getTarget: () => Planet | null;
  getStatus: () => SurfaceStatus;
  getProgress: () => number;
  getRocketInteraction: () => SurfaceRocketInteractionSnapshot;
  onLockRequest: () => void;
  onPointerLockState: (cb: (locked: boolean) => void) => void;
  onReturn: () => void;
  onBoardRocket: () => boolean;
  onCancelBoarding: () => void;
  onLaunchFromSurface: (planet: Planet) => void;
}

export function mountSurfaceHud(args: Args): () => void {
  const targetName = document.getElementById("surface-target-name");
  const flavor = document.getElementById("surface-flavor");
  const tempEl = document.getElementById("surface-temp");
  const status = document.getElementById("surface-status");
  const lockPrompt = document.getElementById("surface-lock-prompt");
  const returnBtn = document.getElementById("surface-return-btn") as HTMLButtonElement | null;
  const screen = document.getElementById("screen-surface");
  const rocketPrompt = document.getElementById("surface-rocket-prompt") as HTMLButtonElement | null;
  const rocketDistance = document.getElementById("surface-rocket-distance");
  const rocketStatus = document.getElementById("surface-rocket-status");
  const rocketRange = document.getElementById("surface-rocket-range");
  const modal = document.getElementById("surface-destination-modal");
  const modalClose = document.getElementById("surface-destination-close") as HTMLButtonElement | null;
  const modalCurrent = document.getElementById("surface-current-location");
  const destinationGrid = document.getElementById("surface-destination-grid");
  const detailName = document.getElementById("surface-destination-detail-name");
  const detailFlavor = document.getElementById("surface-destination-detail-flavor");
  const detailDistance = document.getElementById("surface-destination-detail-distance");
  const detailGravity = document.getElementById("surface-destination-detail-gravity");
  const detailAtmosphere = document.getElementById("surface-destination-detail-atmosphere");
  const detailTemp = document.getElementById("surface-destination-detail-temp");
  const launchBtn = document.getElementById("surface-destination-launch") as HTMLButtonElement | null;

  let raf = 0;
  let plannerOpen = false;
  let pointerLocked = false;
  let selectedPlanet: Planet | null = null;
  const destinationCards = new Map<string, HTMLButtonElement>();

  args.onPointerLockState((locked) => {
    pointerLocked = locked;
    if (lockPrompt) lockPrompt.classList.toggle("is-hidden", locked || plannerOpen);
  });

  const onShow = (): void => {
    const planet = args.getTarget();
    if (!planet) return;
    if (targetName) targetName.textContent = planet.name.toUpperCase();
    if (flavor) flavor.textContent = planet.flavor;
    if (tempEl) tempEl.textContent = planet.surfaceTemp;
    if (lockPrompt) lockPrompt.classList.remove("is-hidden");
    closePlanner();
    renderDestinationCards();
    pollStatus();
  };

  function pollStatus(): void {
    const s = args.getStatus();
    if (status) {
      status.classList.remove("chip--warn", "chip--err");
      switch (s) {
        case "loading": {
          const pct = Math.round(args.getProgress() * 100);
          status.textContent = pct > 0
            ? `Streaming Surface · ${pct}%`
            : "Streaming Surface…";
          status.classList.add("chip--warn");
          break;
        }
        case "ready":
          status.textContent = "Lander Touchdown";
          break;
        case "error":
          status.textContent = "Splat Load Error";
          status.classList.add("chip--err");
          break;
        default:
          status.textContent = "Standby";
      }
    }
    updateRocketHud();
    raf = requestAnimationFrame(pollStatus);
  }

  function updateRocketHud(): void {
    const interaction = args.getRocketInteraction();
    const current = args.getTarget();
    const distanceText = Number.isFinite(interaction.distance)
      ? `${interaction.distance.toFixed(1)} m`
      : "—";

    if (rocketDistance) rocketDistance.textContent = distanceText;
    if (rocketRange) {
      rocketRange.textContent = `${interaction.boardRange.toFixed(1)} m`;
    }
    if (rocketStatus) {
      rocketStatus.textContent = interaction.ready
        ? interaction.inRange
          ? "Boarding range"
          : interaction.hintVisible
            ? "Vanguard located"
            : "Telemetry faint"
        : interaction.loading
          ? "Vehicle resolving"
          : "Vehicle offline";
    }

    // Spawn is within boarding hint range, so the full-width rocket CTA can
    // sit on top of the canvas and steal clicks meant for pointer lock.
    // Only surface the boarding affordance after the player has engaged
    // walk mode (then ESC hides it again until they re-click to engage).
    const showPrompt =
      Boolean(screen?.classList.contains("is-active")) &&
      interaction.hintVisible &&
      pointerLocked &&
      !plannerOpen;
    if (rocketPrompt) {
      rocketPrompt.classList.toggle("is-visible", showPrompt);
      rocketPrompt.disabled = !showPrompt;
      rocketPrompt.setAttribute("aria-hidden", showPrompt ? "false" : "true");
      rocketPrompt.dataset.inRange = String(interaction.inRange);
    }

    if (modalCurrent && current) {
      modalCurrent.textContent = `CURRENT LOCATION · ${current.name.toUpperCase()}`;
    }
  }

  function renderDestinationCards(): void {
    if (!destinationGrid) return;
    destinationGrid.innerHTML = "";
    destinationCards.clear();
    const current = args.getTarget();

    PLANETS.forEach((planet) => {
      const isCurrent = current?.id === planet.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "surface-destination-card";
      card.disabled = isCurrent;
      card.dataset.planetId = planet.id;
      card.style.setProperty("--planet-light", planet.theme.light);
      card.style.setProperty("--planet-mid", planet.theme.mid);
      card.style.setProperty("--planet-dark", planet.theme.dark);
      card.style.setProperty("--planet-glow", planet.theme.glow);
      card.innerHTML = `
        <span class="surface-destination-card__orb" aria-hidden="true"></span>
        <span class="surface-destination-card__body">
          <strong>${planet.name}</strong>
          <span>${isCurrent ? "Current landing site" : planet.tagline}</span>
        </span>
        <span class="surface-destination-card__meta">${formatDistance(planet.distanceMkm)}</span>
      `;
      const onClick = (): void => {
        if (isCurrent) return;
        playCue("click");
        selectDestination(planet);
      };
      const onHover = (): void => {
        if (!isCurrent) playCue("hover");
      };
      card.addEventListener("click", onClick);
      card.addEventListener("mouseenter", onHover);
      destinationCards.set(planet.id, card);
      destinationGrid.appendChild(card);
    });

    const firstOther = PLANETS.find((planet) => planet.id !== current?.id) ?? null;
    selectDestination(firstOther);
  }

  function selectDestination(planet: Planet | null): void {
    selectedPlanet = planet;
    destinationCards.forEach((card, id) => {
      card.classList.toggle("is-selected", id === planet?.id);
    });
    if (!planet) {
      if (detailName) detailName.textContent = "SELECT TARGET";
      if (detailFlavor) detailFlavor.textContent = "No outbound destination available.";
      if (detailDistance) detailDistance.textContent = "—";
      if (detailGravity) detailGravity.textContent = "—";
      if (detailAtmosphere) detailAtmosphere.textContent = "—";
      if (detailTemp) detailTemp.textContent = "—";
      if (launchBtn) launchBtn.disabled = true;
      return;
    }
    if (detailName) detailName.textContent = planet.name.toUpperCase();
    if (detailFlavor) detailFlavor.textContent = planet.flavor;
    if (detailDistance) detailDistance.textContent = formatDistance(planet.distanceMkm);
    if (detailGravity) detailGravity.textContent = `${planet.gravityG.toFixed(2)} g`;
    if (detailAtmosphere) detailAtmosphere.textContent = planet.atmosphere;
    if (detailTemp) detailTemp.textContent = planet.surfaceTemp;
    if (launchBtn) launchBtn.disabled = false;
  }

  function openPlanner(): void {
    if (plannerOpen) return;
    const interaction = args.getRocketInteraction();
    if (!interaction.hintVisible) {
      playCue("alert");
      return;
    }
    // `requestBoarding` releases pointer lock and stops movement when the
    // scene reports an exact in-range state. If a frame lands between the
    // HUD prompt becoming visible and the scene proximity snapshot updating,
    // still open the planner: the prompt itself is only shown inside the
    // safe boarding envelope, so this avoids a "click did nothing" edge.
    args.onBoardRocket();
    plannerOpen = true;
    renderDestinationCards();
    modal?.classList.add("is-open");
    modal?.setAttribute("aria-hidden", "false");
    lockPrompt?.classList.add("is-hidden");
    rocketPrompt?.classList.remove("is-visible");
  }

  function closePlanner(): void {
    if (!plannerOpen) return;
    plannerOpen = false;
    modal?.classList.remove("is-open");
    modal?.setAttribute("aria-hidden", "true");
    args.onCancelBoarding();
  }

  const observer = new MutationObserver(() => {
    if (screen?.classList.contains("is-active")) {
      onShow();
    } else {
      cancelAnimationFrame(raf);
    }
  });
  if (screen) observer.observe(screen, { attributes: true, attributeFilter: ["class"] });

  const onLockClick = (): void => {
    playCue("click");
    args.onLockRequest();
  };
  lockPrompt?.addEventListener("click", onLockClick);

  const onReturn = (): void => {
    playCue("click");
    args.onReturn();
  };
  returnBtn?.addEventListener("click", onReturn);

  const onBoardClick = (): void => {
    playCue("click");
    openPlanner();
  };
  rocketPrompt?.addEventListener("click", onBoardClick);

  const onModalClose = (): void => {
    playCue("click");
    closePlanner();
  };
  modalClose?.addEventListener("click", onModalClose);

  const onLaunch = (): void => {
    if (!selectedPlanet) return;
    playCue("launch");
    args.onLaunchFromSurface(selectedPlanet);
    closePlanner();
  };
  launchBtn?.addEventListener("click", onLaunch);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!screen?.classList.contains("is-active")) return;
    if (event.code === "Escape" && plannerOpen) {
      event.preventDefault();
      closePlanner();
      return;
    }
    if (event.code === "KeyE" && !event.repeat && !plannerOpen) {
      const interaction = args.getRocketInteraction();
      if (!interaction.hintVisible) return;
      event.preventDefault();
      openPlanner();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    lockPrompt?.removeEventListener("click", onLockClick);
    returnBtn?.removeEventListener("click", onReturn);
    rocketPrompt?.removeEventListener("click", onBoardClick);
    modalClose?.removeEventListener("click", onModalClose);
    launchBtn?.removeEventListener("click", onLaunch);
    window.removeEventListener("keydown", onKeyDown);
    destinationCards.clear();
    destinationGrid?.replaceChildren();
  };
}

function formatDistance(mkm: number): string {
  if (mkm < 1) {
    return `${(mkm * 1000).toFixed(0)} k km`;
  }
  if (mkm >= 1000) {
    return `${(mkm / 1000).toFixed(2)} B km`;
  }
  return `${mkm.toFixed(0)} M km`;
}
