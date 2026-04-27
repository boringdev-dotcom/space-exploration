import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";

import type { SceneManager } from "../scenes/SceneManager";

/**
 * Always-on debug overlay.
 *
 * Renders a small fixed-position panel that streams per-frame state about the
 * scene manager + surface splat: active scene, splat status/URL/progress,
 * splat geometry stats (bounding box, splat count), camera pose/FOV, etc.
 *
 * Toggle with the `~` (backtick) key or the `?debug=1` URL flag. Hidden by
 * default so dev builds match the normal cockpit composition unless explicitly
 * debugging.
 */

interface DebugHudArgs {
  manager: SceneManager;
}

export function mountDebugHud({ manager }: DebugHudArgs): () => void {
  const params = new URLSearchParams(window.location.search);
  const forceOn = params.has("debug") || params.has("d");
  const startVisible = forceOn;

  const root = document.createElement("div");
  root.id = "debug-hud";
  root.dataset.visible = String(startVisible);
  root.innerHTML = `
    <header>
      <strong>DEBUG · F1 / ~ to toggle</strong>
      <span id="debug-hud-build">build ${(import.meta.env?.MODE ?? "?")}</span>
    </header>
    <pre id="debug-hud-body">…</pre>
    <footer>
      <button type="button" id="debug-hud-copy">Copy</button>
      <button type="button" id="debug-hud-close">Hide</button>
    </footer>
  `;
  document.body.appendChild(root);

  const body = root.querySelector<HTMLPreElement>("#debug-hud-body")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#debug-hud-copy")!;
  const closeBtn = root.querySelector<HTMLButtonElement>("#debug-hud-close")!;

  let raf = 0;
  let lastSnapshot = "";

  const fmt = (n: number, digits = 3): string =>
    Number.isFinite(n) ? n.toFixed(digits) : String(n);
  const fmtV = (v: THREE.Vector3, digits = 3): string =>
    `${fmt(v.x, digits)}, ${fmt(v.y, digits)}, ${fmt(v.z, digits)}`;

  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    if (root.dataset.visible !== "true") return;

    const lines: string[] = [];

    const { active, state, surface } = manager.getDebugState();
    lines.push(`state:        ${state}`);
    lines.push(
      `activeScene:  ${active === manager.surface ? "surface" : active === manager.flight ? "flight" : "launch"}`,
    );
    lines.push(`activeChild#: ${active.scene.children.length}`);

    const cam = active.camera as THREE.PerspectiveCamera;
    lines.push("");
    lines.push(`camera.pos:   ${fmtV(cam.position)}`);
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ");
    lines.push(
      `camera.eul:   yaw ${fmt(THREE.MathUtils.radToDeg(e.y), 1)}°  pitch ${fmt(THREE.MathUtils.radToDeg(e.x), 1)}°  roll ${fmt(THREE.MathUtils.radToDeg(e.z), 1)}°`,
    );
    lines.push(
      `camera.fov:   ${fmt(cam.fov, 2)}  near ${cam.near}  far ${cam.far}`,
    );
    lines.push(`canvas:       ${window.innerWidth}×${window.innerHeight}  dpr ${window.devicePixelRatio}`);

    if (active === manager.surface) {
      lines.push("");
      lines.push("--- surface ---");
      lines.push(`status:       ${surface.status}`);
      lines.push(`progress:     ${(surface.progress * 100).toFixed(1)}%`);
      lines.push(`pointerLock:  ${surface.isLocked}`);
      lines.push(`splatUrl:     ${surface.splatUrl ?? "(none)"}`);
      lines.push(`splatCount:   ${surface.splatCount ?? "—"}`);
      lines.push(`splat.pos:    ${surface.splatPosition ? fmtV(surface.splatPosition) : "—"}`);
      lines.push(
        `splat.quat:   ${surface.splatQuaternion ? `${fmt(surface.splatQuaternion.x)}, ${fmt(surface.splatQuaternion.y)}, ${fmt(surface.splatQuaternion.z)}, ${fmt(surface.splatQuaternion.w)}` : "—"}`,
      );
      lines.push(
        `splat.scale:  ${surface.splatScale ? fmtV(surface.splatScale) : "—"}`,
      );
      if (surface.bbox) {
        lines.push(`bbox.min:     ${fmtV(surface.bbox.min, 2)}`);
        lines.push(`bbox.max:     ${fmtV(surface.bbox.max, 2)}`);
        const size = new THREE.Vector3().subVectors(surface.bbox.max, surface.bbox.min);
        const ctr = new THREE.Vector3().addVectors(surface.bbox.max, surface.bbox.min).multiplyScalar(0.5);
        lines.push(`bbox.size:    ${fmtV(size, 2)}`);
        lines.push(`bbox.center:  ${fmtV(ctr, 2)}`);
      } else {
        lines.push(`bbox:         —`);
      }
      if (surface.lastError) {
        lines.push("");
        lines.push(`error:        ${surface.lastError}`);
      }
    }

    const text = lines.join("\n");
    if (text !== lastSnapshot) {
      body.textContent = text;
      lastSnapshot = text;
    }
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.code === "Backquote" || ev.key === "F1") {
      ev.preventDefault();
      const next = root.dataset.visible !== "true";
      root.dataset.visible = String(next);
    }
  };
  window.addEventListener("keydown", onKey);

  copyBtn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(body.textContent ?? "");
    copyBtn.textContent = "Copied";
    window.setTimeout(() => (copyBtn.textContent = "Copy"), 900);
  });
  closeBtn.addEventListener("click", () => {
    root.dataset.visible = "false";
  });

  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey);
    root.remove();
  };
}

/**
 * Snapshot of the surface scene's runtime state, exposed by `SurfaceScene`
 * for the debug HUD. Wrapping it in a single object keeps the debug API
 * decoupled from the scene's internals.
 */
export interface SurfaceDebugSnapshot {
  status: string;
  progress: number;
  isLocked: boolean;
  splatUrl: string | null;
  splatCount: number | null;
  splatPosition: THREE.Vector3 | null;
  splatQuaternion: THREE.Quaternion | null;
  splatScale: THREE.Vector3 | null;
  bbox: THREE.Box3 | null;
  lastError: string | null;
  splat: SplatMesh | null;
}
