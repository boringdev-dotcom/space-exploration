import type { Planet } from "../data/planets";
import type { SurfaceStatus } from "../scenes/SurfaceScene";
import { playCue } from "../util/audio";

interface Args {
  getTarget: () => Planet | null;
  getStatus: () => SurfaceStatus;
  getProgress: () => number;
  onLockRequest: () => void;
  onPointerLockState: (cb: (locked: boolean) => void) => void;
  onReturn: () => void;
}

export function mountSurfaceHud(args: Args): () => void {
  const targetName = document.getElementById("surface-target-name");
  const flavor = document.getElementById("surface-flavor");
  const tempEl = document.getElementById("surface-temp");
  const status = document.getElementById("surface-status");
  const lockPrompt = document.getElementById("surface-lock-prompt");
  const returnBtn = document.getElementById("surface-return-btn") as HTMLButtonElement | null;
  const screen = document.getElementById("screen-surface");

  let raf = 0;

  args.onPointerLockState((locked) => {
    if (lockPrompt) lockPrompt.classList.toggle("is-hidden", locked);
  });

  const onShow = (): void => {
    const planet = args.getTarget();
    if (!planet) return;
    if (targetName) targetName.textContent = planet.name.toUpperCase();
    if (flavor) flavor.textContent = planet.flavor;
    if (tempEl) tempEl.textContent = planet.surfaceTemp;
    if (lockPrompt) lockPrompt.classList.remove("is-hidden");
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
    raf = requestAnimationFrame(pollStatus);
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

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    lockPrompt?.removeEventListener("click", onLockClick);
    returnBtn?.removeEventListener("click", onReturn);
  };
}
