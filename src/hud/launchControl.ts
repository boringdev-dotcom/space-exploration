import { playCue } from "../util/audio";

interface Args {
  onLaunch: () => void;
  onHangar: () => void;
}

interface HangarArgs {
  getStatus: () => string;
  onContinue: () => void;
}

/** Drives the LAUNCH CONTROL screen: animated countdown + launch button. */
export function mountLaunchHud({ onLaunch, onHangar }: Args): () => void {
  const button = document.getElementById("launch-btn") as HTMLButtonElement | null;
  const hangarButton = document.getElementById("launch-hangar-btn") as HTMLButtonElement | null;
  const countdown = document.getElementById("launch-countdown") as HTMLElement | null;
  if (!button || !countdown) {
    return () => {};
  }

  let secondsLeft = 4 * 60 + 28;

  const update = (): void => {
    secondsLeft = Math.max(0, secondsLeft - 1);
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    countdown.textContent = `00:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };
  const interval = window.setInterval(update, 1000);

  const onHover = (): void => playCue("hover");
  const onClick = (): void => {
    onLaunch();
  };
  const onHangarClick = (): void => onHangar();
  button.addEventListener("mouseenter", onHover);
  button.addEventListener("click", onClick);
  hangarButton?.addEventListener("mouseenter", onHover);
  hangarButton?.addEventListener("click", onHangarClick);

  return () => {
    window.clearInterval(interval);
    button.removeEventListener("mouseenter", onHover);
    button.removeEventListener("click", onClick);
    hangarButton?.removeEventListener("mouseenter", onHover);
    hangarButton?.removeEventListener("click", onHangarClick);
  };
}

export function mountHangarHud({ getStatus, onContinue }: HangarArgs): () => void {
  const continueBtn = document.getElementById("hangar-continue-btn") as HTMLButtonElement | null;
  const status = document.getElementById("hangar-model-status");
  const sync = document.getElementById("hangar-sync-readout");
  if (!continueBtn) {
    return () => {};
  }

  let frameId = 0;

  const update = (): void => {
    const currentStatus = getStatus();
    if (status) status.textContent = currentStatus;
    if (sync) {
      sync.textContent =
        currentStatus === "ROCKET READY"
          ? "100%"
          : currentStatus === "MODEL OFFLINE"
            ? "BYPASS"
            : "SYNCING";
    }
    continueBtn.disabled = currentStatus === "LOADING ROCKET";
    frameId = window.requestAnimationFrame(update);
  };

  const onHover = (): void => playCue("hover");
  const onClick = (): void => {
    playCue("click");
    onContinue();
  };

  continueBtn.addEventListener("mouseenter", onHover);
  continueBtn.addEventListener("click", onClick);
  update();

  return () => {
    window.cancelAnimationFrame(frameId);
    continueBtn.removeEventListener("mouseenter", onHover);
    continueBtn.removeEventListener("click", onClick);
  };
}
