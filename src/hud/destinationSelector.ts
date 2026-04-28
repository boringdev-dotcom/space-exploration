import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { PLANETS, type Planet } from "../data/planets";
import { playCue } from "../util/audio";
import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";

interface Args {
  onPreview: (planet: Planet) => void;
  onSelect: (planet: Planet) => void;
  onLaunch: (planet: Planet) => void;
}

/** Renders the Destination Selector: 4 holographic planet cards. */
export function mountSelectHud({ onPreview, onSelect, onLaunch }: Args): () => void {
  const grid = document.getElementById("planet-grid");
  const previewHost = document.getElementById("select-model-preview");
  const emptyState = document.getElementById("select-preview-empty");
  const missionPanel = document.getElementById("select-mission-panel");
  const detailName = document.getElementById("select-detail-name");
  const detailFlavor = document.getElementById("select-detail-flavor");
  const detailDistance = document.getElementById("select-detail-distance");
  const detailGravity = document.getElementById("select-detail-gravity");
  const detailAtmosphere = document.getElementById("select-detail-atmosphere");
  const detailTemp = document.getElementById("select-detail-temp");
  const status = document.getElementById("select-preview-status");
  const coords = document.getElementById("select-preview-coords");
  const sector = document.getElementById("select-preview-sector");
  const mode = document.getElementById("select-preview-mode");
  const launchBtn = document.getElementById("select-launch-btn") as HTMLButtonElement | null;
  if (!grid) return () => {};

  grid.innerHTML = "";
  const cleanups: Array<() => void> = [];
  const cards = new Map<string, HTMLButtonElement>();
  const mapPreview = previewHost ? mountMapModelPreview(previewHost) : null;
  let selectedPlanet: Planet | null = null;

  const selectPlanet = (planet: Planet): void => {
    selectedPlanet = planet;
    onSelect(planet);

    cards.forEach((card, id) => {
      card.classList.toggle("is-selected", id === planet.id);
      card.setAttribute("aria-pressed", id === planet.id ? "true" : "false");
    });

    if (emptyState) emptyState.hidden = true;
    if (missionPanel) missionPanel.hidden = false;
    if (detailName) detailName.textContent = planet.name.toUpperCase();
    if (detailFlavor) detailFlavor.textContent = planet.flavor;
    if (detailDistance) detailDistance.textContent = formatDistance(planet.distanceMkm);
    if (detailGravity) detailGravity.textContent = `${planet.gravityG.toFixed(2)} g`;
    if (detailAtmosphere) detailAtmosphere.textContent = planet.atmosphere;
    if (detailTemp) detailTemp.textContent = planet.surfaceTemp;
    if (coords) coords.textContent = targetCoords(planet);
    if (sector) sector.textContent = `SEC: ${planet.id.toUpperCase()}_APPROACH`;
    if (mode) mode.textContent = "DRAG TO INSPECT";
    if (status) status.textContent = "SYS_TRACKING: TARGET LOCK";

    mapPreview?.preview(planet);
  };

  PLANETS.forEach((planet, idx) => {
    const card = document.createElement("button");
    card.type = "button";
    card.setAttribute("aria-pressed", "false");
    card.className = `planet-card fade-in${planet.modelUrl ? " has-model" : ""}`;
    card.style.animationDelay = `${idx * 80}ms`;
    card.style.setProperty("--planet-light", planet.theme.light);
    card.style.setProperty("--planet-mid", planet.theme.mid);
    card.style.setProperty("--planet-dark", planet.theme.dark);
    card.style.setProperty("--planet-glow", planet.theme.glow);

    card.innerHTML = `
      <div class="planet-card__visual">
        <div class="planet-card__orb"></div>
        ${planet.modelUrl ? '<div class="planet-card__model" aria-hidden="true"></div>' : ""}
      </div>
      <div class="planet-card__body">
        <div class="planet-card__name">${planet.name}</div>
        <div class="planet-card__sub">${planet.tagline}</div>
        <div class="planet-card__stats">
          <div class="telemetry__row">
            <span class="telemetry__label">Distance</span>
            <span class="telemetry__value t-mono">${formatDistance(planet.distanceMkm)}</span>
          </div>
          <div class="telemetry__row">
            <span class="telemetry__label">Gravity</span>
            <span class="telemetry__value t-mono">${planet.gravityG.toFixed(2)} g</span>
          </div>
          <div class="telemetry__row">
            <span class="telemetry__label">Atmos.</span>
            <span class="telemetry__value t-mono">${planet.atmosphere}</span>
          </div>
          <div class="telemetry__row">
            <span class="telemetry__label">Temp</span>
            <span class="telemetry__value t-mono">${planet.surfaceTemp}</span>
          </div>
        </div>
      </div>
    `;

    const modelHost = card.querySelector<HTMLElement>(".planet-card__model");
    const modelPreview = planet.modelUrl && modelHost
      ? mountCardModelPreview(modelHost, planet)
      : null;

    const onHover = (): void => {
      playCue("hover");
      onPreview(planet);
    };
    const onFocus = (): void => onPreview(planet);
    const onClick = (event: MouseEvent): void => {
      if (modelPreview?.shouldSuppressClick()) {
        event.preventDefault();
        return;
      }
      playCue("click");
      selectPlanet(planet);
    };
    card.addEventListener("mouseenter", onHover);
    card.addEventListener("focus", onFocus);
    card.addEventListener("click", onClick);
    cleanups.push(() => {
      card.removeEventListener("mouseenter", onHover);
      card.removeEventListener("focus", onFocus);
      card.removeEventListener("click", onClick);
      modelPreview?.cleanup();
    });

    grid.appendChild(card);
    cards.set(planet.id, card);
  });

  const launch = (): void => {
    if (!selectedPlanet) return;
    playCue("launch");
    onLaunch(selectedPlanet);
  };
  const onLaunchHover = (): void => playCue("hover");
  launchBtn?.addEventListener("mouseenter", onLaunchHover);
  launchBtn?.addEventListener("click", launch);

  return () => {
    cleanups.forEach((fn) => fn());
    mapPreview?.cleanup();
    launchBtn?.removeEventListener("mouseenter", onLaunchHover);
    launchBtn?.removeEventListener("click", launch);
    grid.innerHTML = "";
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

function targetCoords(planet: Planet): string {
  const seed = planet.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const x = seed * 7.31 - 420;
  const y = seed * -2.17 + 1020;
  const z = planet.gravityG * -0.03;
  return `COORD: X${formatSigned(x, 2)} Y${formatSigned(y, 1)} Z${formatSigned(z, 3)}`;
}

function formatSigned(value: number, digits: number): string {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}

interface CardModelPreview {
  cleanup: () => void;
  shouldSuppressClick: () => boolean;
}

interface MapModelPreview {
  preview: (planet: Planet) => void;
  cleanup: () => void;
}

interface CardPreviewTuning {
  diameter: number;
  cameraY: number;
  cameraZ: number;
  minDistance: number;
  maxDistance: number;
  rotation: THREE.EulerTuple;
  position: THREE.Vector3Tuple;
  ambient: [color: number, intensity: number];
  key: [color: number, intensity: number];
  rim: [color: number, intensity: number];
}

const DEFAULT_CARD_PREVIEW: CardPreviewTuning = {
  diameter: 3.15,
  cameraY: 0.15,
  cameraZ: 4.5,
  minDistance: 2.8,
  maxDistance: 6.0,
  rotation: [0.08, -0.45, 0],
  position: [0, 0, 0],
  ambient: [0xffd7bd, 1.45],
  key: [0xffdfbd, 3.2],
  rim: [0x8fdcff, 1.25],
};

const CARD_PREVIEW_BY_PLANET: Partial<Record<string, Partial<CardPreviewTuning>>> = {
  luna: {
    diameter: 2.55,
    cameraY: 0,
    cameraZ: 4.8,
    minDistance: 3.1,
    maxDistance: 6.5,
    rotation: [0.02, 1.7, 0],
    ambient: [0xeaf4ff, 1.15],
    key: [0xffffff, 2.4],
    rim: [0x9fcfff, 1.5],
  },
  europa: {
    diameter: 2.3,
    cameraY: 0,
    cameraZ: 4.9,
    minDistance: 3.1,
    maxDistance: 6.6,
    rotation: [0.0, -1.25, 0],
    position: [0, 0, 0],
    ambient: [0xe8f7ff, 1.25],
    key: [0xf8fcff, 2.55],
    rim: [0x8fdcff, 1.9],
  },
  titan: {
    diameter: 2.75,
    cameraZ: 4.7,
    minDistance: 3.0,
    maxDistance: 6.4,
  },
};

const MAP_PREVIEW_BY_PLANET: Partial<Record<string, Partial<CardPreviewTuning>>> = {
  luna: {
    diameter: 4.2,
    cameraY: 0.05,
    cameraZ: 6.2,
    minDistance: 3.8,
    maxDistance: 9.2,
    rotation: [0.02, 1.4, 0],
    ambient: [0xeaf4ff, 1.25],
    key: [0xffffff, 2.6],
    rim: [0x9fcfff, 1.7],
  },
  mars: {
    diameter: 4.8,
    cameraY: 0.05,
    cameraZ: 6.5,
    minDistance: 4.2,
    maxDistance: 10.5,
    rotation: [0.05, -0.8, 0],
  },
  europa: {
    diameter: 4.1,
    cameraY: 0.04,
    cameraZ: 6.6,
    minDistance: 4.1,
    maxDistance: 10,
    rotation: [0, -1.15, 0],
    ambient: [0xe8f7ff, 1.35],
    key: [0xf8fcff, 2.7],
    rim: [0x8fdcff, 2.0],
  },
  titan: {
    diameter: 4.8,
    cameraY: 0.1,
    cameraZ: 6.4,
    minDistance: 4.1,
    maxDistance: 10.2,
    rotation: [0.08, -0.5, 0],
  },
};

function mountMapModelPreview(host: HTMLElement): MapModelPreview {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 100);
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.domElement.className = "select-model-preview__canvas";
  host.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.rotateSpeed = 0.65;
  controls.panSpeed = 0.35;
  controls.zoomSpeed = 0.75;
  controls.target.set(0, 0, 0);

  let ambient: THREE.AmbientLight | null = null;
  let key: THREE.DirectionalLight | null = null;
  let rim: THREE.DirectionalLight | null = null;
  let model: THREE.Group | null = null;
  let disposed = false;
  let loadId = 0;
  let frameId = 0;

  const setLights = (tuning: CardPreviewTuning): void => {
    if (ambient) scene.remove(ambient);
    if (key) scene.remove(key);
    if (rim) scene.remove(rim);

    ambient = new THREE.AmbientLight(tuning.ambient[0], tuning.ambient[1]);
    key = new THREE.DirectionalLight(tuning.key[0], tuning.key[1]);
    key.position.set(3.5, 2.4, 4.2);
    rim = new THREE.DirectionalLight(tuning.rim[0], tuning.rim[1]);
    rim.position.set(-4, 1.6, -3.2);

    scene.add(ambient, key, rim);
  };

  const resize = (): void => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  const render = (): void => {
    frameId = window.requestAnimationFrame(render);
    controls.update();
    if (model) model.rotation.y += 0.0018;
    renderer.render(scene, camera);
  };
  render();

  const clearModel = (): void => {
    if (!model) return;
    scene.remove(model);
    disposeObjectTree(model);
    model = null;
  };

  return {
    preview: (planet: Planet): void => {
      loadId += 1;
      const currentLoadId = loadId;
      clearModel();

      const tuning = {
        ...DEFAULT_CARD_PREVIEW,
        diameter: 4.8,
        cameraY: 0.08,
        cameraZ: 6.4,
        minDistance: 4.0,
        maxDistance: 10.5,
        ...MAP_PREVIEW_BY_PLANET[planet.id],
      };

      camera.position.set(0, tuning.cameraY, tuning.cameraZ);
      controls.minDistance = tuning.minDistance;
      controls.maxDistance = tuning.maxDistance;
      controls.target.set(0, 0, 0);
      controls.update();
      setLights(tuning);

      if (!planet.modelUrl) return;

      void loadNormalizedGltfModel(planet.modelUrl, tuning.diameter)
        .then((loaded) => {
          if (disposed || currentLoadId !== loadId) {
            disposeObjectTree(loaded);
            return;
          }

          model = loaded;
          model.rotation.set(...tuning.rotation);
          model.position.set(...tuning.position);
          scene.add(model);
        })
        .catch((err) => {
          console.warn("[DestinationSelector] failed to load map GLB", err);
        });
    },
    cleanup: () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      clearModel();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function mountCardModelPreview(host: HTMLElement, planet: Planet): CardModelPreview {
  const tuning = {
    ...DEFAULT_CARD_PREVIEW,
    ...CARD_PREVIEW_BY_PLANET[planet.id],
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);
  camera.position.set(0, tuning.cameraY, tuning.cameraZ);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.domElement.className = "planet-card__model-canvas";
  host.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(tuning.ambient[0], tuning.ambient[1]));

  const key = new THREE.DirectionalLight(tuning.key[0], tuning.key[1]);
  key.position.set(2.5, 2.0, 3.0);
  scene.add(key);

  const rim = new THREE.DirectionalLight(tuning.rim[0], tuning.rim[1]);
  rim.position.set(-3.0, 1.2, -2.5);
  scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.minDistance = tuning.minDistance;
  controls.maxDistance = tuning.maxDistance;
  controls.rotateSpeed = 0.75;
  controls.panSpeed = 0.35;
  controls.zoomSpeed = 0.75;
  controls.target.set(0, 0, 0);

  let model: THREE.Group | null = null;
  let disposed = false;
  let suppressClickUntil = 0;
  let pointerDown = false;
  let pointerMoved = false;
  let frameId = 0;

  const markModelInteraction = (): void => {
    suppressClickUntil = performance.now() + 300;
  };

  const resize = (): void => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  void loadNormalizedGltfModel(planet.modelUrl ?? "", tuning.diameter)
    .then((loaded) => {
      if (disposed) {
        disposeObjectTree(loaded);
        return;
      }

      model = loaded;
      model.rotation.set(...tuning.rotation);
      model.position.set(...tuning.position);
      scene.add(model);
    })
    .catch((err) => {
      console.warn("[DestinationSelector] failed to load card GLB", err);
    });

  const render = (): void => {
    frameId = window.requestAnimationFrame(render);
    controls.update();
    if (model && performance.now() > suppressClickUntil) {
      model.rotation.y += 0.0025;
    }
    renderer.render(scene, camera);
  };
  render();

  const onPointerDown = (event: PointerEvent): void => {
    pointerDown = true;
    pointerMoved = false;
    event.stopPropagation();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (pointerDown) {
      pointerMoved = true;
      markModelInteraction();
    }
    event.stopPropagation();
  };
  const onPointerUp = (event: PointerEvent): void => {
    pointerDown = false;
    if (pointerMoved) {
      markModelInteraction();
    }
    event.stopPropagation();
  };
  const onWheel = (event: WheelEvent): void => {
    markModelInteraction();
    event.stopPropagation();
  };

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  host.addEventListener("wheel", onWheel);

  return {
    cleanup: () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("wheel", onWheel);
      controls.dispose();
      disposeObjectTree(model);
      renderer.dispose();
      renderer.domElement.remove();
    },
    shouldSuppressClick: () => performance.now() < suppressClickUntil,
  };
}
