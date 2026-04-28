import { playCue } from "../util/audio";

interface Args {
  onLaunch: () => void;
}

/** Drives the LAUNCH CONTROL screen: animated countdown + launch button. */
export function mountLaunchHud({ onLaunch }: Args): () => void {
  const button = document.getElementById("launch-btn") as HTMLButtonElement | null;
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
    button.disabled = true;
    onLaunch();
  };
  button.addEventListener("mouseenter", onHover);
  button.addEventListener("click", onClick);

  return () => {
    window.clearInterval(interval);
    button.removeEventListener("mouseenter", onHover);
    button.removeEventListener("click", onClick);
  };
}
