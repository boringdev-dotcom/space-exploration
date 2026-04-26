import type { Planet } from "../data/planets";
import { playCue } from "../util/audio";

interface Args {
  getTarget: () => Planet | null;
  onDeploy: () => void;
  onReroute: () => void;
}

export function mountArrivalHud(args: Args): () => void {
  const targetName = document.getElementById("arrival-target-name");
  const gravity = document.getElementById("arrival-gravity");
  const atmosphere = document.getElementById("arrival-atmosphere");
  const temp = document.getElementById("arrival-temp");
  const deployBtn = document.getElementById("arrival-deploy-btn") as HTMLButtonElement | null;
  const backBtn = document.getElementById("arrival-back-btn") as HTMLButtonElement | null;
  const screen = document.getElementById("screen-arrival");

  const onShow = (): void => {
    const planet = args.getTarget();
    if (!planet) return;
    if (targetName) targetName.textContent = planet.name.toUpperCase();
    if (gravity) gravity.textContent = `${planet.gravityG.toFixed(2)} g`;
    if (atmosphere) atmosphere.textContent = planet.atmosphere;
    if (temp) temp.textContent = planet.surfaceTemp;
  };

  const observer = new MutationObserver(() => {
    if (screen?.classList.contains("is-active")) onShow();
  });
  if (screen) observer.observe(screen, { attributes: true, attributeFilter: ["class"] });

  const deploy = (): void => {
    playCue("click");
    args.onDeploy();
  };
  const reroute = (): void => {
    playCue("click");
    args.onReroute();
  };
  deployBtn?.addEventListener("click", deploy);
  backBtn?.addEventListener("click", reroute);

  return () => {
    observer.disconnect();
    deployBtn?.removeEventListener("click", deploy);
    backBtn?.removeEventListener("click", reroute);
  };
}
