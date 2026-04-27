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
  const alignOn = params.has("align") || params.has("alignment");
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
  const alignment = alignOn ? createAlignmentOverlay() : null;

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
    if (alignment) {
      updateAlignmentOverlay(alignment, manager);
    }
    if (root.dataset.visible !== "true") return;

    const lines: string[] = [];

    const { active, state, surface } = manager.getDebugState();
    const flight = manager.flight.getDestinationDebugSnapshot();
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

    if (active === manager.flight) {
      const projected = flight.screen;
      lines.push("");
      lines.push("--- alignment ---");
      lines.push(`viewport:     ${fmt(window.innerWidth / 2, 1)}, ${fmt(window.innerHeight / 2, 1)}`);
      lines.push(`reticle:      ${fmtRectCenter("#screen-flight .reticle")}`);
      lines.push(`target:       ${projected ? `${fmt(projected.x, 1)}, ${fmt(projected.y, 1)}` : "—"}`);
      lines.push(
        `targetDelta:  ${projected ? `${fmt(projected.x - window.innerWidth / 2, 1)}, ${fmt(projected.y - window.innerHeight / 2, 1)}` : "—"}`,
      );
      lines.push(`targetWorld:  ${fmtV(flight.position, 2)}`);
      if (flight.boundsCenter) {
        lines.push(`modelCenter:  ${fmtV(flight.boundsCenter, 2)}`);
        lines.push(`modelScreen:  ${flight.boundsScreen ? `${fmt(flight.boundsScreen.x, 1)}, ${fmt(flight.boundsScreen.y, 1)}` : "—"}`);
      }
    }

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
    alignment?.remove();
    root.remove();
  };
}

function fmtRectCenter(selector: string): string {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return "—";
  const r = el.getBoundingClientRect();
  return `${(r.left + r.width / 2).toFixed(1)}, ${(r.top + r.height / 2).toFixed(1)}`;
}

function createAlignmentOverlay(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "alignment-debug";
  overlay.innerHTML = `
    <div class="alignment-debug__line alignment-debug__line--x"></div>
    <div class="alignment-debug__line alignment-debug__line--y"></div>
    <div class="alignment-debug__marker alignment-debug__marker--viewport">VIEW</div>
    <div class="alignment-debug__marker alignment-debug__marker--target">3D</div>
    <div class="alignment-debug__marker alignment-debug__marker--reticle">HUD</div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function updateAlignmentOverlay(overlay: HTMLElement, manager: SceneManager): void {
  const { active } = manager.getDebugState();
  overlay.dataset.visible = String(active === manager.flight);
  if (active !== manager.flight) return;

  const viewport = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const flight = manager.flight.getDestinationDebugSnapshot();
  const target = flight.boundsScreen ?? flight.screen ?? viewport;
  const reticleEl = document.querySelector<HTMLElement>("#screen-flight .reticle");
  const reticleRect = reticleEl?.getBoundingClientRect();
  const reticle = reticleRect
    ? { x: reticleRect.left + reticleRect.width / 2, y: reticleRect.top + reticleRect.height / 2 }
    : viewport;

  setMarker(overlay, "viewport", viewport);
  setMarker(overlay, "target", target);
  setMarker(overlay, "reticle", reticle);
}

function setMarker(overlay: HTMLElement, name: string, point: { x: number; y: number }): void {
  const marker = overlay.querySelector<HTMLElement>(`.alignment-debug__marker--${name}`);
  if (!marker) return;
  marker.style.left = `${point.x}px`;
  marker.style.top = `${point.y}px`;
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
