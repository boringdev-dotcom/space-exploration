import * as THREE from "three";
import type { MissionTelemetry, ControlMode } from "../scenes/MissionScene";
import type { FlightDynamicsInput } from "../scenes/FlightDynamics";
import { COCKPIT_GLB_URL } from "../data/assetUrls";
import { loadGltfRaw } from "./gltfModel";
import { damp } from "./feel";

export interface CockpitState {
  input: FlightDynamicsInput;
  telemetry: MissionTelemetry | null;
  controlMode: ControlMode | null;
  cockpitWeight: number;
}

export interface CockpitInteractionCallbacks {
  onToggleAutopilot?: () => void;
  onCycleView?: () => void;
  onToggleHeadlights?: (enabled: boolean) => void;
}

export interface ProceduralCockpit {
  group: THREE.Group;
  update: (state: CockpitState, dt: number, elapsed: number) => void;
  dispose: () => void;
  attachInteractive: (
    domElement: HTMLElement,
    camera: THREE.Camera,
    callbacks: CockpitInteractionCallbacks,
  ) => void;
  /** Set when GLB `Pilot_Eye` carries numeric `fov_recommended` in extras. */
  getCockpitFovHintDegrees: () => number | null;
}

type ScreenKind = "pfd" | "mission" | "engine";

interface ScreenSurface {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  kind: ScreenKind;
}

interface ClickableControl {
  mesh: THREE.Mesh;
  baseEmissive: number;
  hoverEmissive: number;
  activeEmissive: number;
  active: boolean;
  kind: "autopilot" | "view" | "headlights";
}

type Vec3Axis = "x" | "y" | "z";
type EulerAxis = "x" | "y" | "z";

/** Resolved slide control parsed from a GLB node's `extras`. */
interface GlbControl {
  node: THREE.Object3D;
  /** Position-axis for slide controls (throttle). */
  axis: Vec3Axis;
  /** Initial value at rest (idle). Throttle = full-back. */
  start: number;
  /** Total travel from start (positive when forward). */
  range: number;
  /** Pivot-axis names for rotate controls (yoke). */
  pitchAxis: EulerAxis;
  rollAxis: EulerAxis;
  maxPitch: number;
  maxRoll: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const degToRad = (deg: number): number => (deg * Math.PI) / 180;
const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

/**
 * After aligning Pilot_Eye to the rig anchor (`model.position = -eye`),
 * artificially **raise** eye.y — the hull translates down relative to the
 * camera anchor, eliminating the player spawning "under"/outside the fuselage.
 * Overrides: `Pilot_Eye` extras `snap_bias_y`, `snap_bias_forward`.
 */
const DEFAULT_GLTF_COCKPIT_SNAP_BIAS_Y = 0.52;

/**
 * Moves the snap slightly along cockpit **−local Z**, matching ship nose
 * (same −Z forward convention as the flight camera rig); helps when the authored eye
 * marker sits aft of the real seated viewpoint.
 */
const DEFAULT_GLTF_COCKPIT_SNAP_BIAS_FWD = 0.14;

const _cockpitSnapShipFwd = new THREE.Vector3(0, 0, -1);
interface CockpitMaterials {
  hull: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  carbonPanel: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  brushed: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  cyan: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  display: THREE.MeshStandardMaterial;
}

export function createProceduralCockpit(): ProceduralCockpit {
  const group = new THREE.Group();
  group.name = "proceduralCockpit.flightDeck";

  const materials = createMaterials();
  const screens: ScreenSurface[] = [];
  const sticks: Array<{ mount: THREE.Group; pivot: THREE.Group }> = [];
  const annunciators: THREE.Mesh[] = [];
  const clickables: ClickableControl[] = [];

  const throttleLever = new THREE.Group();
  const boostLever = new THREE.Group();
  const attitudeBall = new THREE.Group();
  const targetReticle = new THREE.Group();

  const cabinKey = new THREE.PointLight(0x9adfff, 1.6, 4.2, 1.6);
  const cabinFill = new THREE.PointLight(0x274255, 0.7, 5, 1.4);
  const consoleGlow = new THREE.PointLight(0x4cd6ff, 0.95, 2.4, 1.7);
  const warningGlow = new THREE.PointLight(0xffb45a, 0.18, 1.6, 1.6);

  /** Hidden when the GLB ships its own punctual lights (Point/Spot/Dir). */
  const proceduralFillLights = new THREE.Group();
  proceduralFillLights.name = "proceduralCockpit.fillLights";
  proceduralFillLights.add(cabinKey, cabinFill, consoleGlow, warningGlow);

  const dynamicGroup = new THREE.Group();
  dynamicGroup.name = "proceduralCockpit.dynamicOverlay";

  // Build everything — the GLB (if any) is added underneath the dynamic
  // overlay so screens/yokes always sit on top regardless of asset bounds.
  const proceduralShell = buildProceduralShell(materials);
  group.add(proceduralShell);
  group.add(dynamicGroup);

  buildAnimatedOverlay(
    dynamicGroup,
    materials,
    screens,
    sticks,
    throttleLever,
    boostLever,
    attitudeBall,
    targetReticle,
    annunciators,
    clickables,
  );

  cabinKey.position.set(0, 0.55, -0.1);
  cabinFill.position.set(0, -0.1, 0.4);
  consoleGlow.position.set(0, -0.32, -0.55);
  warningGlow.position.set(0.7, -0.18, -0.7);
  group.add(proceduralFillLights);

  // Optional GLB: try to load a real cockpit asset; on failure, we keep the
  // procedural shell which is built to look great on its own. Names follow
  // the contract authored on the asset side:
  //   - `throttle_slide` (extras.slide_axis="Y", max_forward, max_back)
  //   - `yoke_pivot` (extras.pitch_axis="X", roll_axis="Y", max_pitch_deg, max_roll_deg)
  //   - optional `Pilot_Eye` / `Cockpit_Camera` Empty for exact head alignment
  //     (extras `fov_recommended`, `snap_bias_y`, `snap_bias_forward`)
  //   - `MFD_Screen_1`..`MFD_Screen_9` for our CanvasTexture displays
  //   - Blender windshields often lie on +local Z while this sim treats −Z as
  //     forward; imported GLBs are rotated π about Y before Pilot_Eye alignment.
  let glbScene: THREE.Group | null = null;
  let glbThrottle: GlbControl | null = null;
  let glbYoke: GlbControl | null = null;
  let disposed = false;
  let cockpitFovHintDeg: number | null = null;

  // Fallback animation hooks for Sketchfab-style cockpits that ship un-authored
  // node names (no `throttle_slide` / `yoke_pivot` extras). These animate the
  // visible levers + steering wheel directly from the player's input.
  let fallbackThrottleNode: THREE.Object3D | null = null;
  const fallbackThrottleBaseRotX = { v: 0 };
  let fallbackSteeringNode: THREE.Object3D | null = null;
  const fallbackSteeringBaseRot = new THREE.Euler();

  void loadGltfRaw(COCKPIT_GLB_URL)
    .then((model) => {
      if (disposed) return;
      glbScene = model;
      // Blender ship interiors often face +local Z toward the windshield, but
      // CockpitRig / rocket flight convention is −Z forward. Without this,
      // the pilot camera stares aft into bulkheads (milky solids / empty hull).
      model.rotation.y = Math.PI;
      model.updateMatrixWorld(true);
      const namedNodes = collectNamedNodes(model);
      glbThrottle = readSlideControl(namedNodes.get("throttle_slide"));
      glbYoke = readPivotControl(namedNodes.get("yoke_pivot"));
      assignScreensToMfds(namedNodes, screens);
      tuneGlbMaterials(model, namedNodes);
      tuneImportedPunctualLights(model);
      cockpitFovHintDeg = readPilotEyeFovHint(namedNodes.get("Pilot_Eye"));

      // If the mesh ships punctual lamps, suppress our placeholder fill —
      // otherwise two lighting stacks bloom the cabin unpleasantly.
      let punctualInGlb = 0;
      model.traverse((child) => {
        if (child instanceof THREE.Light) punctualInGlb += 1;
      });
      proceduralFillLights.visible = punctualInGlb === 0;

      // Author convention: optional `Pilot_Eye` Empty / bone marks the pupil;
      // otherwise seats are averaged with a seated height lift. Translating by
      // `-eye` places that point at the cockpit group origin (= pilot head
      // per CockpitRig). See estimatePilotEye.
      const eye = estimatePilotEye(namedNodes);
      applyGlbPilotEyeSnapBias(
        eye,
        namedNodes.get("Pilot_Eye") ??
          namedNodes.get("Cockpit_Camera") ??
          namedNodes.get("Pilot_View"),
      );
      model.position.set(-eye.x, -eye.y, -eye.z);

      // Hide the procedural shell + animated overlay so the GLB owns the
      // visuals. The animated CanvasTextures live on materials we already
      // patched onto the GLB MFDs above, so the screens still update from
      // telemetry every frame.
      proceduralShell.visible = false;
      dynamicGroup.visible = false;
      group.add(model);

      // Re-target the clickable hotspots to a few GLB buttons so the
      // player can still toggle autopilot, view mode, and headlights
      // without floating UI cubes.
      retargetClickablesToGlb(clickables, namedNodes);

      // Sketchfab-style cockpits without authored controls: bind the
      // visible levers + dashboard glow directly. These hooks are
      // visual-only (they don't influence the sim) and only fire when
      // their node names exist on the loaded GLB.
      if (!glbThrottle) {
        const t = namedNodes.get("throttle");
        if (t) {
          fallbackThrottleNode = t;
          fallbackThrottleBaseRotX.v = t.rotation.x;
        }
      }
      if (!glbYoke) {
        const s = namedNodes.get("steering");
        if (s) {
          fallbackSteeringNode = s;
          fallbackSteeringBaseRot.copy(s.rotation);
        }
      }
    })
    .catch(() => {
      // No GLB present — that's fine, procedural shell is the visual.
    });

  // ===== Animation state =====
  let stickPitch = 0;
  let stickRoll = 0;
  let stickYaw = 0;
  let throttleAngle = 0;
  let boostAngle = 0;
  let screenAccum = 1; // Force initial draw on first update.

  const update = (state: CockpitState, dt: number, elapsed: number): void => {
    group.visible = state.cockpitWeight > 0.015;
    if (!group.visible) return;

    const pitch = clamp(state.input.pitchRate, -1, 1);
    const yaw = clamp(state.input.yawRate, -1, 1);
    const roll = clamp(state.input.rollRate, -1, 1);
    const throttle = clamp01(state.input.throttle / 2);
    const boost = clamp01(state.input.boost);

    // Sticks: tilt forward/back with pitch, side-to-side with roll, yaw twist.
    stickPitch = damp(stickPitch, pitch * degToRad(14), 12, dt);
    stickRoll = damp(stickRoll, -roll * degToRad(20), 13, dt);
    stickYaw = damp(stickYaw, yaw * degToRad(11), 10, dt);
    for (const stick of sticks) {
      stick.pivot.rotation.x = stickPitch;
      stick.pivot.rotation.z = stickRoll;
      stick.pivot.rotation.y = stickYaw;
    }

    throttleAngle = damp(throttleAngle, degToRad(-30 + throttle * 60), 9, dt);
    boostAngle = damp(boostAngle, degToRad(-22 + boost * 52), 12, dt);
    throttleLever.rotation.x = throttleAngle;
    boostLever.rotation.x = boostAngle;

    // GLB-authored controls. The throttle slides along its declared axis
    // (max_forward at full power, max_back at idle); the yoke rotates on
    // the pitch and roll axes named in extras. Throttle target uses both
    // the player's throttle and a small boost component so the lever
    // visually overshoots into the boost detent.
    if (glbThrottle) {
      const t = clamp01(throttle * 0.85 + boost * 0.25);
      const target = glbThrottle.start + (glbThrottle.range * t);
      const node = glbThrottle.node;
      const axis = glbThrottle.axis;
      const cur = (node.position as THREE.Vector3)[axis];
      (node.position as THREE.Vector3)[axis] = damp(cur, target, 9, dt);
    }
    if (glbYoke) {
      const node = glbYoke.node;
      const pitchTarget = pitch * glbYoke.maxPitch;
      const rollTarget = -roll * glbYoke.maxRoll;
      const eul = node.rotation;
      eul[glbYoke.pitchAxis] = damp(eul[glbYoke.pitchAxis], pitchTarget, 12, dt);
      eul[glbYoke.rollAxis] = damp(eul[glbYoke.rollAxis], rollTarget, 13, dt);
    }

    // Fallback throttle: tip the lever forward with throttle, slight extra
    // travel from boost. `throttle` here is already normalised 0..1.
    if (fallbackThrottleNode) {
      const t = clamp01(throttle * 0.85 + boost * 0.25);
      const targetX =
        fallbackThrottleBaseRotX.v - t * degToRad(35);
      fallbackThrottleNode.rotation.x = damp(
        fallbackThrottleNode.rotation.x,
        targetX,
        9,
        dt,
      );
    }

    // Fallback yoke: roll the wheel with player roll, tip with pitch.
    if (fallbackSteeringNode) {
      const targetRollY =
        fallbackSteeringBaseRot.y + -roll * degToRad(28);
      const targetPitchX =
        fallbackSteeringBaseRot.x + pitch * degToRad(8);
      fallbackSteeringNode.rotation.y = damp(
        fallbackSteeringNode.rotation.y,
        targetRollY,
        13,
        dt,
      );
      fallbackSteeringNode.rotation.x = damp(
        fallbackSteeringNode.rotation.x,
        targetPitchX,
        12,
        dt,
      );
    }


    // Mechanical attitude indicator + target reticle on the dashboard.
    attitudeBall.rotation.z = state.telemetry
      ? degToRad(-state.telemetry.shipRollDeg)
      : -stickRoll;
    attitudeBall.rotation.x = state.telemetry
      ? degToRad(state.telemetry.shipPitchDeg * 0.4)
      : stickPitch;
    targetReticle.position.x = state.telemetry
      ? clamp(state.telemetry.targetBearingDeg / 90, -1, 1) * 0.12
      : yaw * 0.06;
    targetReticle.position.y = state.telemetry
      ? clamp(state.telemetry.targetElevationDeg / 45, -1, 1) * 0.09
      : -pitch * 0.05;

    // Annunciator pulse — gentle, with boost-driven amplification.
    for (let i = 0; i < annunciators.length; i++) {
      const mat = annunciators[i].material as THREE.MeshStandardMaterial;
      const pulse = 0.62 + Math.sin(elapsed * (2.2 + i * 0.07) + i) * 0.22;
      mat.emissiveIntensity = pulse + boost * 0.6;
    }

    if (proceduralFillLights.visible) {
      cabinKey.intensity = 1.4 + throttle * 0.35 + boost * 0.6;
      consoleGlow.intensity = 0.9 + throttle * 0.5;
      warningGlow.intensity =
        boost > 0.05 ? 0.55 + Math.sin(elapsed * 14) * 0.25 : 0.16;
    }

    // Update clickable hover / active emissive levels (smooth ramp).
    for (const ctrl of clickables) {
      const mat = ctrl.mesh.material as THREE.MeshStandardMaterial;
      const target = ctrl.active ? ctrl.activeEmissive : ctrl.baseEmissive;
      mat.emissiveIntensity = damp(mat.emissiveIntensity, target, 8, dt);
    }

    // Throttle screen redraw to ~20 Hz so the canvases stay crisp + cheap.
    screenAccum += dt;
    if (screenAccum > 0.05) {
      screenAccum = 0;
      for (const s of screens) {
        drawScreen(s, state, elapsed, throttle, boost);
        s.texture.needsUpdate = true;
      }
    }
  };

  // ===== Interaction (raycasting) =====
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let interactiveDom: HTMLElement | null = null;
  let interactiveCamera: THREE.Camera | null = null;
  let callbacks: CockpitInteractionCallbacks = {};
  let hoverCtrl: ClickableControl | null = null;
  let interactiveCockpitWeight = 0;

  const intersectControl = (event: PointerEvent): ClickableControl | null => {
    if (!interactiveDom || !interactiveCamera) return null;
    if (interactiveCockpitWeight < 0.6) return null;
    const rect = interactiveDom.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, interactiveCamera);
    const meshes = clickables.map((c) => c.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0].object as THREE.Mesh;
    return clickables.find((c) => c.mesh === hit) ?? null;
  };

  const onPointerMove = (event: PointerEvent): void => {
    const next = intersectControl(event);
    if (next === hoverCtrl) return;
    if (hoverCtrl) {
      const mat = hoverCtrl.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = hoverCtrl.active
        ? hoverCtrl.activeEmissive
        : hoverCtrl.baseEmissive;
    }
    hoverCtrl = next;
    if (hoverCtrl) {
      const mat = hoverCtrl.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = hoverCtrl.hoverEmissive;
      if (interactiveDom) interactiveDom.style.cursor = "pointer";
    } else if (interactiveDom) {
      interactiveDom.style.cursor = "";
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    const hit = intersectControl(event);
    if (!hit) return;
    event.stopPropagation();
    if (hit.kind === "autopilot") {
      hit.active = !hit.active;
      callbacks.onToggleAutopilot?.();
    } else if (hit.kind === "view") {
      callbacks.onCycleView?.();
    } else if (hit.kind === "headlights") {
      hit.active = !hit.active;
      callbacks.onToggleHeadlights?.(hit.active);
    }
  };

  const attachInteractive = (
    dom: HTMLElement,
    camera: THREE.Camera,
    cbs: CockpitInteractionCallbacks,
  ): void => {
    if (interactiveDom) {
      interactiveDom.removeEventListener("pointermove", onPointerMove);
      interactiveDom.removeEventListener("pointerdown", onPointerDown, true);
    }
    interactiveDom = dom;
    interactiveCamera = camera;
    callbacks = cbs;
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerdown", onPointerDown, true);
  };

  // Track cockpit weight so interaction is only active in cockpit view.
  const baseUpdate = update;
  const wrappedUpdate: ProceduralCockpit["update"] = (state, dt, elapsed) => {
    interactiveCockpitWeight = state.cockpitWeight;
    baseUpdate(state, dt, elapsed);
  };

  const dispose = (): void => {
    disposed = true;
    if (interactiveDom) {
      interactiveDom.removeEventListener("pointermove", onPointerMove);
      interactiveDom.removeEventListener("pointerdown", onPointerDown, true);
      interactiveDom.style.cursor = "";
    }
    for (const s of screens) {
      s.texture.dispose();
      s.material.dispose();
    }
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    Object.values(materials).forEach((m) => m.dispose());
    if (glbScene) {
      glbScene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
    }
  };

  // Paint screens once so cockpit is never blank on first display.
  for (const s of screens) {
    drawScreen(s, null, 0, 0, 0);
    s.texture.needsUpdate = true;
  }

  const getCockpitFovHintDegrees = (): number | null => cockpitFovHintDeg;

  return {
    group,
    update: wrappedUpdate,
    dispose,
    attachInteractive,
    getCockpitFovHintDegrees,
  };
}

// ===========================================================================
// Materials — built once, shared across every mesh in the cockpit. Carbon
// and brushed metal use procedurally-painted CanvasTextures so we never need
// any external texture assets.
// ===========================================================================

function createMaterials(): CockpitMaterials {
  const carbonTex = makeCarbonFiberTexture();
  const brushedTex = makeBrushedMetalTexture();
  const panelTex = makePanelDetailTexture();

  return {
    hull: new THREE.MeshStandardMaterial({
      color: 0x252b35,
      roughness: 0.55,
      metalness: 0.55,
    }),
    panel: new THREE.MeshStandardMaterial({
      color: 0x14181f,
      roughness: 0.7,
      metalness: 0.4,
      map: panelTex,
    }),
    carbonPanel: new THREE.MeshStandardMaterial({
      color: 0x0e1218,
      roughness: 0.45,
      metalness: 0.7,
      map: carbonTex,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: 0x6b7383,
      roughness: 0.32,
      metalness: 0.85,
      map: brushedTex,
    }),
    brushed: new THREE.MeshStandardMaterial({
      color: 0x9aa3b2,
      roughness: 0.28,
      metalness: 0.9,
      map: brushedTex,
    }),
    rubber: new THREE.MeshStandardMaterial({
      color: 0x070708,
      roughness: 0.95,
      metalness: 0.05,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xa9e3ff,
      transparent: true,
      opacity: 0.08,
      roughness: 0.02,
      metalness: 0,
      transmission: 0.6,
      thickness: 0.02,
      depthWrite: false,
    }),
    cyan: new THREE.MeshStandardMaterial({
      color: 0x041218,
      emissive: 0x00e0ff,
      emissiveIntensity: 1.05,
      roughness: 0.45,
      metalness: 0.1,
    }),
    amber: new THREE.MeshStandardMaterial({
      color: 0x141008,
      emissive: 0xffb24a,
      emissiveIntensity: 1.0,
      roughness: 0.5,
      metalness: 0.1,
    }),
    red: new THREE.MeshStandardMaterial({
      color: 0x140607,
      emissive: 0xff362f,
      emissiveIntensity: 1.05,
      roughness: 0.5,
      metalness: 0.1,
    }),
    green: new THREE.MeshStandardMaterial({
      color: 0x05140b,
      emissive: 0x6cf09c,
      emissiveIntensity: 0.85,
      roughness: 0.5,
      metalness: 0.1,
    }),
    white: new THREE.MeshStandardMaterial({
      color: 0x0c1418,
      emissive: 0xeaf6ff,
      emissiveIntensity: 0.6,
      roughness: 0.5,
      metalness: 0.1,
    }),
    display: new THREE.MeshStandardMaterial({
      color: 0x0a1014,
      roughness: 0.4,
      metalness: 0.2,
    }),
  };
}

function makeCarbonFiberTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0d1117";
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 8) {
    for (let x = 0; x < 256; x += 8) {
      const offset = (y / 8) % 2 === 0 ? 0 : 4;
      const grad = g.createLinearGradient(x + offset, y, x + offset + 8, y + 8);
      grad.addColorStop(0, "#1b232c");
      grad.addColorStop(0.5, "#0a0f14");
      grad.addColorStop(1, "#1b232c");
      g.fillStyle = grad;
      g.fillRect(x + offset, y, 8, 8);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBrushedMetalTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#9da7b6";
  g.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 600; i++) {
    g.strokeStyle = `rgba(${30 + Math.random() * 40},${36 + Math.random() * 40},${44 + Math.random() * 40},${0.06 + Math.random() * 0.18})`;
    g.lineWidth = 1;
    g.beginPath();
    const y = Math.random() * 64;
    g.moveTo(0, y);
    g.lineTo(512, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePanelDetailTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  // Base
  g.fillStyle = "#161a22";
  g.fillRect(0, 0, 512, 512);
  // Subtle noise
  for (let i = 0; i < 2000; i++) {
    g.fillStyle = `rgba(${Math.random() * 40 + 10},${Math.random() * 50 + 10},${Math.random() * 60 + 10},${Math.random() * 0.18})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
  }
  // Panel seams
  g.strokeStyle = "rgba(0,0,0,0.55)";
  g.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    const x = (i + 1) * 96;
    g.moveTo(x, 0);
    g.lineTo(x, 512);
    g.stroke();
  }
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    const y = (i + 1) * 102;
    g.moveTo(0, y);
    g.lineTo(512, y);
    g.stroke();
  }
  // Rivets
  g.fillStyle = "rgba(220,225,235,0.18)";
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 5; j++) {
      const x = (i + 1) * 96 - 1;
      const y = (j + 1) * 102 - 1;
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ===========================================================================
// Procedural geometry — designed to look great even without a GLB. Uses
// curved surfaces (tori, cylinders, lathes) and beveled extrusions instead
// of plain boxes so the cabin reads as a real flight deck.
// ===========================================================================

function buildProceduralShell(mat: CockpitMaterials): THREE.Group {
  const shell = new THREE.Group();
  shell.name = "proceduralCockpit.shell";

  buildCabinHull(shell, mat);
  buildWindshield(shell, mat);
  buildFloor(shell, mat);
  buildSeats(shell, mat);
  buildOverhead(shell, mat);

  return shell;
}

function buildCabinHull(parent: THREE.Group, mat: CockpitMaterials): void {
  // Curved cabin walls — half-cylinder behind the pilot wraps the cabin.
  const cylinder = new THREE.CylinderGeometry(1.45, 1.55, 1.85, 32, 1, true, -Math.PI / 2, Math.PI);
  const wall = new THREE.Mesh(cylinder, mat.hull);
  wall.name = "cabinWall";
  wall.rotation.x = Math.PI / 2;
  wall.position.set(0, 0.05, 0.55);
  parent.add(wall);

  // Curved ceiling shell forward of the pilot.
  const ceilGeom = new THREE.CylinderGeometry(1.05, 1.25, 1.4, 32, 1, true, Math.PI * 0.1, Math.PI * 0.8);
  const ceiling = new THREE.Mesh(ceilGeom, mat.carbonPanel);
  ceiling.name = "cabinCeiling";
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 0.55, -0.4);
  parent.add(ceiling);

  // Side hull blisters with a brushed-metal trim band.
  for (const x of [-1.05, 1.05]) {
    const blister = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 1.05, 1.6),
      mat.panel,
    );
    blister.name = "sideHull";
    blister.position.set(x, 0.05, -0.05);
    blister.rotation.z = x < 0 ? degToRad(-7) : degToRad(7);
    parent.add(blister);

    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.06, 1.6),
      mat.brushed,
    );
    trim.name = "sideHullTrim";
    trim.position.set(x, 0.34, -0.05);
    trim.rotation.z = x < 0 ? degToRad(-7) : degToRad(7);
    parent.add(trim);
  }

  // Rear bulkhead with subtle glow stripe.
  const bulkhead = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 1.2, 0.08),
    mat.carbonPanel,
  );
  bulkhead.name = "rearBulkhead";
  bulkhead.position.set(0, 0.05, 0.85);
  parent.add(bulkhead);

  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.025, 0.06),
    mat.cyan,
  );
  stripe.name = "rearGlowStripe";
  stripe.position.set(0, -0.18, 0.81);
  parent.add(stripe);
}

function buildWindshield(parent: THREE.Group, mat: CockpitMaterials): void {
  // Wide curved windshield: three angled glass panels with thin mullions.
  const widths = [0.74, 0.92, 0.74];
  const heights = [0.62, 0.7, 0.62];
  const yaws = [degToRad(20), 0, degToRad(-20)];
  const xs = [-0.78, 0, 0.78];
  for (let i = 0; i < 3; i++) {
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(widths[i], heights[i]),
      mat.glass,
    );
    glass.name = `windshield_${i}`;
    glass.position.set(xs[i], 0.18, -1.18 + Math.abs(xs[i]) * 0.12);
    glass.rotation.y = yaws[i];
    glass.renderOrder = 5;
    parent.add(glass);
  }

  // Beveled mullions between glass panes.
  const mullionGeom = new THREE.BoxGeometry(0.05, 0.78, 0.05);
  for (const x of [-0.4, 0.4]) {
    const m = new THREE.Mesh(mullionGeom, mat.trim);
    m.name = "mullion";
    m.position.set(x, 0.2, -1.16);
    parent.add(m);
  }

  // Upper window crown with embedded reading lights.
  const crown = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.13, 0.18), mat.trim);
  crown.name = "windowCrown";
  crown.position.set(0, 0.58, -1.06);
  parent.add(crown);

  const crownLight = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.018, 0.04),
    mat.white,
  );
  crownLight.name = "crownReadingLight";
  crownLight.position.set(0, 0.52, -1.0);
  parent.add(crownLight);

  // Lower window sill (where the dashboard meets the glass).
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 0.18), mat.brushed);
  sill.name = "windowSill";
  sill.position.set(0, -0.18, -1.05);
  parent.add(sill);

  // Outer A-pillars angled in.
  for (const x of [-1.16, 1.16]) {
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 1.0, 0.14),
      mat.brushed,
    );
    pillar.name = "aPillar";
    pillar.position.set(x, 0.12, -0.95);
    pillar.rotation.z = x < 0 ? degToRad(-12) : degToRad(12);
    pillar.rotation.x = degToRad(-2);
    parent.add(pillar);
  }
}

function buildFloor(parent: THREE.Group, mat: CockpitMaterials): void {
  // Floor pan with diamond-plate effect via a subtly emissive grid.
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 0.05, 1.85),
    mat.carbonPanel,
  );
  floor.name = "floorPan";
  floor.position.set(0, -0.92, -0.2);
  parent.add(floor);

  for (let i = -8; i <= 8; i++) {
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.012, 0.012),
      mat.trim,
    );
    rib.name = "floorRib";
    rib.position.set(0, -0.89, -0.6 + i * 0.075);
    parent.add(rib);
  }

  // Foot rests under the dashboard.
  for (const x of [-0.68, 0.68]) {
    const footrest = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.05, 0.32),
      mat.trim,
    );
    footrest.name = "footrest";
    footrest.position.set(x, -0.78, -0.46);
    footrest.rotation.x = degToRad(-12);
    parent.add(footrest);
  }
}

function buildSeats(parent: THREE.Group, mat: CockpitMaterials): void {
  for (const x of [-0.68, 0.68]) {
    const seatGroup = new THREE.Group();
    seatGroup.name = x < 0 ? "pilotSeat" : "copilotSeat";
    seatGroup.position.set(x, -0.42, 0.34);
    parent.add(seatGroup);

    const pan = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.13, 0.55),
      mat.rubber,
    );
    pan.name = "seatPan";
    pan.position.set(0, -0.36, -0.06);
    pan.rotation.x = degToRad(-3);
    seatGroup.add(pan);

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.78, 0.13),
      mat.rubber,
    );
    back.name = "seatBack";
    back.position.set(0, 0.05, 0.18);
    back.rotation.x = degToRad(-12);
    seatGroup.add(back);

    // Headrest with cyan piping.
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.18, 0.13),
      mat.rubber,
    );
    head.name = "seatHeadrest";
    head.position.set(0, 0.5, 0.18);
    head.rotation.x = degToRad(-12);
    seatGroup.add(head);

    const piping = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.012, 0.012),
      mat.cyan,
    );
    piping.name = "seatPiping";
    piping.position.set(0, 0.42, 0.105);
    piping.rotation.x = degToRad(-12);
    seatGroup.add(piping);

    // Side bolsters (curved with thin trim).
    for (const sx of [-0.23, 0.23]) {
      const bolster = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.65, 0.16),
        mat.rubber,
      );
      bolster.name = "seatBolster";
      bolster.position.set(sx, 0.05, 0.16);
      bolster.rotation.x = degToRad(-12);
      seatGroup.add(bolster);
    }

    // Five-point harness anchors (just visible at the seat edge).
    for (const sx of [-0.18, 0.18]) {
      const buckle = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.04, 0.04),
        mat.brushed,
      );
      buckle.name = "harnessBuckle";
      buckle.position.set(sx, -0.28, -0.14);
      seatGroup.add(buckle);
    }
  }
}

function buildOverhead(parent: THREE.Group, mat: CockpitMaterials): void {
  // Recessed overhead switch panel that arcs over the pilots.
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.12, 0.55),
    mat.carbonPanel,
  );
  panel.name = "overheadPanel";
  panel.position.set(0, 0.7, -0.55);
  panel.rotation.x = degToRad(-15);
  parent.add(panel);

  // Rocker switch cluster on overhead.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 11; col++) {
      const x = -0.55 + col * 0.11;
      const z = -0.7 + row * 0.16;
      const switchBox = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.02, 0.05),
        mat.trim,
      );
      switchBox.name = "overheadRockerHousing";
      switchBox.position.set(x, 0.61, z);
      switchBox.rotation.x = degToRad(-15);
      parent.add(switchBox);

      const ledMat = (col + row) % 5 === 0 ? mat.amber : (col + row) % 7 === 0 ? mat.red : mat.green;
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.008, 0.012),
        ledMat,
      );
      led.name = "overheadRockerLED";
      led.position.set(x, 0.6, z + 0.022);
      led.rotation.x = degToRad(-15);
      parent.add(led);
    }
  }
}

// ===========================================================================
// Animated overlay — yokes, throttle, screens, mechanical instruments. These
// are the parts that need to react to flight state every frame.
// ===========================================================================

function buildAnimatedOverlay(
  parent: THREE.Group,
  mat: CockpitMaterials,
  screens: ScreenSurface[],
  sticks: Array<{ mount: THREE.Group; pivot: THREE.Group }>,
  throttleLever: THREE.Group,
  boostLever: THREE.Group,
  attitudeBall: THREE.Group,
  targetReticle: THREE.Group,
  annunciators: THREE.Mesh[],
  clickables: ClickableControl[],
): void {
  buildDashboard(parent, mat, screens, attitudeBall, targetReticle, annunciators, clickables);
  buildThrottleQuadrant(parent, mat, throttleLever, boostLever, annunciators);
  buildSticks(parent, mat, sticks);
}

function buildDashboard(
  parent: THREE.Group,
  mat: CockpitMaterials,
  screens: ScreenSurface[],
  attitudeBall: THREE.Group,
  targetReticle: THREE.Group,
  annunciators: THREE.Mesh[],
  clickables: ClickableControl[],
): void {
  // Curved dashboard shell — wide, tilted up toward the pilot.
  const dashGroup = new THREE.Group();
  dashGroup.name = "dashboardCluster";
  dashGroup.position.set(0, -0.42, -0.86);
  dashGroup.rotation.x = degToRad(13);
  parent.add(dashGroup);

  // Main curved panel using a torus-segment for the brow.
  const brow = new THREE.Mesh(
    new THREE.BoxGeometry(2.05, 0.4, 0.32),
    mat.carbonPanel,
  );
  brow.name = "dashboardBrow";
  brow.position.set(0, 0, 0);
  dashGroup.add(brow);

  const browTrim = new THREE.Mesh(
    new THREE.BoxGeometry(2.1, 0.04, 0.06),
    mat.brushed,
  );
  browTrim.name = "dashboardTrim";
  browTrim.position.set(0, 0.21, 0.13);
  dashGroup.add(browTrim);

  // Three primary MFDs (PFD, mission, propulsion) inset into the brow.
  screens.push(createScreen(dashGroup, "pfd", [-0.62, -0.02, 0.16], [0.5, 0.36], mat, "leftPfd"));
  screens.push(createScreen(dashGroup, "mission", [0, 0.02, 0.18], [0.56, 0.4], mat, "missionDisplay"));
  screens.push(createScreen(dashGroup, "engine", [0.62, -0.02, 0.16], [0.5, 0.36], mat, "rightPfd"));

  // Below-screen gauge strip with annunciators.
  for (let col = 0; col < 22; col++) {
    const x = -0.95 + col * 0.09;
    const ledMat = col % 5 === 0 ? mat.amber : col % 3 === 0 ? mat.cyan : col % 7 === 0 ? mat.red : mat.green;
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.018, 0.018),
      ledMat,
    );
    led.name = "dashAnnunciator";
    led.position.set(x, -0.21, 0.16);
    dashGroup.add(led);
    annunciators.push(led);
  }

  // Mechanical attitude ball housing at left — provides parallax + reads
  // even if the screens are not yet drawn.
  const ballShell = new THREE.Mesh(new THREE.SphereGeometry(0.105, 32, 16), mat.carbonPanel);
  ballShell.name = "attitudeBallHousing";
  ballShell.position.set(-1.0, -0.05, 0.18);
  dashGroup.add(ballShell);

  attitudeBall.name = "attitudeBall";
  attitudeBall.position.copy(ballShell.position);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.085, 32, 16), mat.cyan);
  ball.renderOrder = 4;
  attitudeBall.add(ball);
  // Equator ring for the attitude ball.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.004, 6, 32), mat.amber);
  ring.rotation.x = Math.PI / 2;
  attitudeBall.add(ring);
  dashGroup.add(attitudeBall);

  // Target reticle on the right — a small cyan crosshair that drifts toward
  // the bearing/elevation of the destination.
  targetReticle.name = "targetReticle";
  targetReticle.position.set(1.0, -0.05, 0.18);
  const reticleH = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.01, 0.01), mat.amber);
  const reticleV = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.1, 0.01), mat.amber);
  reticleH.name = "reticleH";
  reticleV.name = "reticleV";
  targetReticle.add(reticleH, reticleV);
  // Surrounding ring on the dash so the reticle has visual context.
  const reticleHousing = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.006, 8, 36), mat.brushed);
  reticleHousing.rotation.x = Math.PI / 2;
  reticleHousing.position.copy(targetReticle.position);
  dashGroup.add(reticleHousing);
  dashGroup.add(targetReticle);

  // Clickable control row — three premium buttons centered on the lower brow.
  const ctrlSpacing = 0.18;
  const ctrlConfigs: Array<{
    kind: ClickableControl["kind"];
    color: THREE.MeshStandardMaterial;
    base: number;
    hover: number;
    active: number;
    initial: boolean;
  }> = [
    { kind: "view", color: mat.cyan, base: 0.5, hover: 1.3, active: 1.5, initial: false },
    { kind: "autopilot", color: mat.green, base: 0.45, hover: 1.2, active: 1.4, initial: false },
    { kind: "headlights", color: mat.amber, base: 0.45, hover: 1.2, active: 1.4, initial: false },
  ];
  ctrlConfigs.forEach((cfg, i) => {
    const x = (i - 1) * ctrlSpacing;
    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.054, 0.02, 24),
      mat.brushed,
    );
    housing.name = `ctrlHousing_${cfg.kind}`;
    housing.rotation.x = Math.PI / 2;
    housing.position.set(x, -0.2, 0.32);
    dashGroup.add(housing);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.044, 0.024, 24),
      cfg.color.clone(),
    );
    (cap.material as THREE.MeshStandardMaterial).emissiveIntensity = cfg.base;
    cap.name = `ctrlCap_${cfg.kind}`;
    cap.rotation.x = Math.PI / 2;
    cap.position.set(x, -0.2, 0.34);
    cap.userData.cockpitControl = cfg.kind;
    dashGroup.add(cap);
    clickables.push({
      mesh: cap,
      baseEmissive: cfg.base,
      hoverEmissive: cfg.hover,
      activeEmissive: cfg.active,
      active: cfg.initial,
      kind: cfg.kind,
    });
  });

  // Center pedestal underneath the dashboard with a knurled trim and a
  // backlit "MASTER" plate so the dashboard reads as a layered console.
  const pedestal = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.18, 0.45),
    mat.panel,
  );
  pedestal.name = "centerPedestal";
  pedestal.position.set(0, -0.32, 0.28);
  dashGroup.add(pedestal);

  const masterPlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.012, 0.06),
    mat.cyan,
  );
  masterPlate.name = "masterPlate";
  masterPlate.position.set(0, -0.23, 0.46);
  dashGroup.add(masterPlate);
  annunciators.push(masterPlate);
}

function buildThrottleQuadrant(
  parent: THREE.Group,
  mat: CockpitMaterials,
  throttleLever: THREE.Group,
  boostLever: THREE.Group,
  annunciators: THREE.Mesh[],
): void {
  const quad = new THREE.Group();
  quad.name = "throttleQuadrant";
  quad.position.set(-0.78, -0.45, -0.24);
  parent.add(quad);

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.09, 0.55),
    mat.carbonPanel,
  );
  base.name = "quadrantBase";
  quad.add(base);

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.02, 0.57),
    mat.brushed,
  );
  trim.name = "quadrantTrim";
  trim.position.y = 0.05;
  quad.add(trim);

  // Throttle lever
  throttleLever.name = "throttleLever";
  throttleLever.position.set(-0.07, 0.04, -0.05);
  const throttleStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.014, 0.22, 16),
    mat.brushed,
  );
  throttleStem.name = "throttleStem";
  throttleStem.position.y = 0.11;
  throttleLever.add(throttleStem);
  const throttleGrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.06, 0.06),
    mat.cyan,
  );
  throttleGrip.name = "throttleGrip";
  throttleGrip.position.y = 0.24;
  throttleLever.add(throttleGrip);
  annunciators.push(throttleGrip);
  quad.add(throttleLever);

  // Boost lever
  boostLever.name = "boostLever";
  boostLever.position.set(0.07, 0.04, -0.05);
  const boostStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.013, 0.2, 16),
    mat.brushed,
  );
  boostStem.name = "boostStem";
  boostStem.position.y = 0.1;
  boostLever.add(boostStem);
  const boostGrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.05, 0.055),
    mat.amber,
  );
  boostGrip.name = "boostGrip";
  boostGrip.position.y = 0.22;
  boostLever.add(boostGrip);
  annunciators.push(boostGrip);
  quad.add(boostLever);

  // Quadrant labels (just emissive segments for "THR / BST").
  const lbl1 = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.005, 0.012),
    mat.white,
  );
  lbl1.position.set(-0.07, 0.07, 0.18);
  quad.add(lbl1);
  const lbl2 = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.005, 0.012),
    mat.white,
  );
  lbl2.position.set(0.07, 0.07, 0.18);
  quad.add(lbl2);
}

function buildSticks(
  parent: THREE.Group,
  mat: CockpitMaterials,
  sticks: Array<{ mount: THREE.Group; pivot: THREE.Group }>,
): void {
  for (const x of [-0.36, 0.36]) {
    const mount = new THREE.Group();
    mount.name = x < 0 ? "pilotStickMount" : "copilotStickMount";
    mount.position.set(x, -0.7, -0.3);
    parent.add(mount);

    // Base plate on the floor.
    const basePlate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.085, 0.04, 24),
      mat.carbonPanel,
    );
    basePlate.name = "stickBasePlate";
    basePlate.position.y = 0;
    mount.add(basePlate);

    const baseRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.078, 0.006, 8, 32),
      mat.brushed,
    );
    baseRing.name = "stickBaseRing";
    baseRing.rotation.x = Math.PI / 2;
    baseRing.position.y = 0.015;
    mount.add(baseRing);

    const pivot = new THREE.Group();
    pivot.name = "stickPivot";
    mount.add(pivot);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.025, 0.32, 16),
      mat.brushed,
    );
    shaft.name = "stickShaft";
    shaft.position.y = 0.16;
    pivot.add(shaft);

    // Pistol grip.
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.18, 0.05),
      mat.rubber,
    );
    grip.name = "stickGrip";
    grip.position.y = 0.36;
    pivot.add(grip);

    // Trigger button.
    const trigger = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.04, 0.03),
      mat.red,
    );
    trigger.name = "stickTrigger";
    trigger.position.set(0, 0.34, -0.04);
    pivot.add(trigger);

    // Hat-switch / thumb cluster on top of the grip.
    const hat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.008, 16),
      mat.cyan,
    );
    hat.name = "stickHatSwitch";
    hat.position.set(0, 0.45, -0.012);
    hat.rotation.x = degToRad(15);
    pivot.add(hat);

    sticks.push({ mount, pivot });
  }
}

// ===========================================================================
// Screens — three CanvasTexture-based MFDs that redraw at ~20 Hz to keep
// per-frame cost low while still feeling alive.
// ===========================================================================

function createScreen(
  parent: THREE.Group,
  kind: ScreenKind,
  position: [number, number, number],
  size: [number, number],
  mat: CockpitMaterials,
  name: string,
): ScreenSurface {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable for cockpit screen");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });

  // Bezel + faceplate so the screen reads as a recessed panel.
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(size[0] + 0.06, size[1] + 0.06, 0.018),
    mat.brushed,
  );
  bezel.name = `${name}Bezel`;
  bezel.position.set(...position);
  parent.add(bezel);

  const inset = new THREE.Mesh(
    new THREE.BoxGeometry(size[0] + 0.012, size[1] + 0.012, 0.006),
    mat.display,
  );
  inset.name = `${name}Inset`;
  inset.position.set(position[0], position[1], position[2] + 0.012);
  parent.add(inset);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2] + 0.018);
  parent.add(mesh);

  return { mesh, canvas, ctx, texture, material, kind };
}

function drawScreen(
  screen: ScreenSurface,
  state: CockpitState | null,
  elapsed: number,
  throttle: number,
  boost: number,
): void {
  const { ctx, canvas } = screen;
  const w = canvas.width;
  const h = canvas.height;
  drawScreenBackground(ctx, w, h, elapsed);

  if (!state?.telemetry) {
    drawStandby(ctx, w, h, screen.kind, elapsed);
    return;
  }

  if (screen.kind === "pfd") {
    drawPfd(ctx, w, h, state.telemetry, elapsed);
  } else if (screen.kind === "mission") {
    drawMission(ctx, w, h, state.telemetry, state.controlMode, elapsed);
  } else {
    drawEngine(ctx, w, h, state.telemetry, throttle, boost, elapsed);
  }

  drawScanlines(ctx, w, h, elapsed);
}

function drawScreenBackground(ctx: CanvasRenderingContext2D, w: number, h: number, elapsed: number): void {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#031016");
  grad.addColorStop(0.55, "#071b24");
  grad.addColorStop(1, "#020508");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0, 243, 255, 0.22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.fillStyle = `rgba(0, 243, 255, ${0.04 + Math.sin(elapsed * 3) * 0.015})`;
  ctx.fillRect(0, 0, w, h);
}

function drawStandby(ctx: CanvasRenderingContext2D, w: number, h: number, label: string, elapsed: number): void {
  ctx.fillStyle = "#00f3ff";
  ctx.font = "700 34px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label.toUpperCase(), w / 2, h / 2 - 20);
  ctx.font = "22px monospace";
  ctx.fillStyle = "rgba(255, 186, 32, 0.9)";
  ctx.fillText(Math.sin(elapsed * 5) > 0 ? "LINK STANDBY" : "AWAITING TELEMETRY", w / 2, h / 2 + 28);
}

function drawPfd(ctx: CanvasRenderingContext2D, w: number, h: number, telem: MissionTelemetry, elapsed: number): void {
  const cx = w / 2;
  const cy = h / 2 + 14;
  ctx.save();
  ctx.beginPath();
  ctx.rect(80, 40, w - 160, h - 80);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(degToRad(telem.shipRollDeg));
  ctx.translate(0, telem.shipPitchDeg * 5);
  ctx.fillStyle = "rgba(36, 116, 180, 0.45)";
  ctx.fillRect(-w, -h * 2, w * 2, h * 2);
  ctx.fillStyle = "rgba(138, 80, 34, 0.36)";
  ctx.fillRect(-w, 0, w * 2, h * 2);
  ctx.strokeStyle = "#f7f0d2";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-w, 0);
  ctx.lineTo(w, 0);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = "22px monospace";
  ctx.textAlign = "center";
  for (let deg = -80; deg <= 80; deg += 10) {
    if (deg === 0) continue;
    const y = -deg * 5;
    const len = deg % 20 === 0 ? 104 : 58;
    ctx.beginPath();
    ctx.moveTo(-len, y);
    ctx.lineTo(-18, y);
    ctx.moveTo(18, y);
    ctx.lineTo(len, y);
    ctx.stroke();
    if (deg % 20 === 0) {
      ctx.fillText(String(Math.abs(deg)), -len - 28, y + 7);
      ctx.fillText(String(Math.abs(deg)), len + 28, y + 7);
    }
  }
  ctx.restore();

  ctx.strokeStyle = "#ffba20";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(cx - 80, cy);
  ctx.lineTo(cx - 22, cy);
  ctx.lineTo(cx, cy + 18);
  ctx.lineTo(cx + 22, cy);
  ctx.lineTo(cx + 80, cy);
  ctx.stroke();

  drawTape(ctx, 22, 76, 96, h - 132, "KM/S", telem.speedKmS, 1);
  drawTape(ctx, w - 118, 76, 96, h - 132, "ALT", telem.altitudeKm, 0);
  ctx.fillStyle = "#00f3ff";
  ctx.font = "20px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${telem.shipRollDeg.toFixed(0).padStart(3, "0")} ROLL`, cx, 40);
  ctx.fillText(`${Math.round(elapsed * 10) % 2 === 0 ? "FLIGHT DIRECTOR" : "VECTOR HOLD"}`, cx, h - 28);
}

function drawMission(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  telem: MissionTelemetry,
  mode: ControlMode | null,
  elapsed: number,
): void {
  ctx.fillStyle = "#00f3ff";
  ctx.font = "700 30px monospace";
  ctx.textAlign = "left";
  ctx.fillText("MISSION", 34, 36);
  ctx.font = "22px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.fillText(`PHASE ${telem.phase.toUpperCase()}`, 34, 82);
  ctx.fillText(`MODE  ${(mode ?? "auto").toUpperCase()}`, 34, 116);
  ctx.fillText(`RANGE ${telem.rangeKm.toFixed(0)} KM`, 34, 150);
  ctx.fillText(`DEST ALT ${telem.destinationAltitudeKm.toFixed(0)} KM`, 34, 184);

  const cx = w * 0.64;
  const cy = h * 0.58;
  const r = 132;
  ctx.strokeStyle = "rgba(0,243,255,0.45)";
  ctx.lineWidth = 3;
  for (const rr of [r, r * 0.66, r * 0.33]) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Sweep arc.
  ctx.strokeStyle = "rgba(0,243,255,0.85)";
  ctx.beginPath();
  const sweep = elapsed * 1.3;
  ctx.arc(cx, cy, r, sweep, sweep + 0.45);
  ctx.stroke();

  const bearing = degToRad(telem.targetBearingDeg);
  const elevationScale = 1 - Math.min(0.45, Math.abs(telem.targetElevationDeg) / 120);
  const bx = cx + Math.sin(bearing) * r * 0.72 * elevationScale;
  const by = cy - Math.cos(bearing) * r * 0.72 * elevationScale;
  ctx.fillStyle = telem.targetInFront ? "#ffba20" : "#888888";
  ctx.beginPath();
  ctx.arc(bx, by, 11 + Math.sin(elapsed * 6) * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#00f3ff";
  ctx.font = "18px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${telem.targetBearingDeg.toFixed(0)} DEG`, cx, cy + r + 35);
}

function drawEngine(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  telem: MissionTelemetry,
  throttle: number,
  boost: number,
  elapsed: number,
): void {
  void h;
  ctx.fillStyle = "#00f3ff";
  ctx.font = "700 30px monospace";
  ctx.textAlign = "left";
  ctx.fillText("PROPULSION", 34, 36);
  drawBar(ctx, 54, 110, w - 108, 34, throttle, "THROTTLE", "#00f3ff");
  drawBar(ctx, 54, 178, w - 108, 34, boost, "BOOST", "#ffba20");
  drawBar(ctx, 54, 246, w - 108, 34, clamp01(telem.speedKmS / 6000), "VELOCITY", "#73ff9d");
  drawBar(ctx, 54, 314, w - 108, 34, clamp01(Math.abs(telem.verticalSpeedKmS) / 1200), "VERT RATE", "#ff5a48");

  ctx.strokeStyle = "rgba(0,243,255,0.38)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const x = 130 + i * 150;
    const y = 420 + Math.sin(elapsed * 5 + i) * 8;
    ctx.beginPath();
    ctx.arc(x, y, 36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = i === 2 && boost > 0.2 ? "#ffba20" : "#00f3ff";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: number,
  digits: number,
): void {
  ctx.fillStyle = "rgba(0,0,0,0.52)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(0,243,255,0.5)";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#00f3ff";
  ctx.font = "18px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, x + w / 2, y + 28);
  ctx.font = "700 24px monospace";
  ctx.fillStyle = "#ffba20";
  ctx.fillText(value.toFixed(digits), x + w / 2, y + h / 2 + 8);
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
  label: string,
  color: string,
): void {
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp01(v), h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.font = "20px monospace";
  ctx.textAlign = "left";
  ctx.fillText(label, x, y - 12);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(v * 100)}%`, x + w, y - 12);
}

function drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number, elapsed: number): void {
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  for (let y = Math.floor((elapsed * 30) % 6); y < h; y += 6) {
    ctx.fillRect(0, y, w, 1);
  }
  const glare = ctx.createLinearGradient(0, 0, w, h);
  glare.addColorStop(0, "rgba(255,255,255,0.08)");
  glare.addColorStop(0.22, "rgba(255,255,255,0.0)");
  glare.addColorStop(1, "rgba(255,255,255,0.0)");
  ctx.fillStyle = glare;
  ctx.fillRect(0, 0, w, h);
}

// ===========================================================================
// GLB integration helpers — drive named author-marked nodes (throttle slide,
// yoke pivot), route MFD screens to our CanvasTextures, and tame glass.
// ===========================================================================

function collectNamedNodes(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    if (obj.name) map.set(obj.name, obj);
  });
  return map;
}

function readSlideControl(node: THREE.Object3D | undefined): GlbControl | null {
  if (!node) return null;
  const extras = (node.userData ?? {}) as {
    control_type?: string;
    slide_axis?: string;
    max_forward?: number;
    max_back?: number;
  };
  if (extras.control_type != null && extras.control_type !== "throttle") {
    return null;
  }
  if (extras.control_type !== "throttle" && node.name !== "throttle_slide") {
    return null;
  }
  const axis = (extras.slide_axis ?? "Y").toLowerCase() as Vec3Axis;
  // start = idle (back). end = full forward (negative on Y for our asset).
  const back = extras.max_back ?? 0.06;
  const forward = extras.max_forward ?? -0.08;
  const baseValue = (node.position as THREE.Vector3)[axis];
  return {
    node,
    axis,
    start: baseValue + back,
    range: forward - back,
    pitchAxis: "x",
    rollAxis: "y",
    maxPitch: 0,
    maxRoll: 0,
  };
}

function readPivotControl(node: THREE.Object3D | undefined): GlbControl | null {
  if (!node) return null;
  const extras = (node.userData ?? {}) as {
    control_type?: string;
    pitch_axis?: string;
    roll_axis?: string;
    max_pitch_deg?: number;
    max_roll_deg?: number;
  };
  if (extras.control_type != null && extras.control_type !== "yoke") {
    return null;
  }
  if (extras.control_type !== "yoke" && node.name !== "yoke_pivot") {
    return null;
  }
  const pitchAxis = (extras.pitch_axis ?? "X").toLowerCase() as EulerAxis;
  const rollAxis = (extras.roll_axis ?? "Y").toLowerCase() as EulerAxis;
  return {
    node,
    axis: "x",
    start: 0,
    range: 0,
    pitchAxis,
    rollAxis,
    maxPitch: ((extras.max_pitch_deg ?? 20) * Math.PI) / 180,
    maxRoll: ((extras.max_roll_deg ?? 30) * Math.PI) / 180,
  };
}

/**
 * Replace materials on the GLB's `MFD_Screen_*` planes with our animated
 * CanvasTextures. We have three displays (PFD, mission, engine); they are
 * mirrored across the available MFD slots so the cockpit never has a
 * blank dashboard panel.
 */
function assignScreensToMfds(
  named: Map<string, THREE.Object3D>,
  screens: ScreenSurface[],
): void {
  if (screens.length === 0) return;
  for (let i = 1; i <= 9; i++) {
    const node = named.get(`MFD_Screen_${i}`);
    if (!node) continue;
    const screen = screens[(i - 1) % screens.length];
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) continue;
    mesh.material = screen.material;
  }
}

/**
 * Blender often exports glTF punctual lights with very large numeric
 * intensities. Our PBR materials, ACES tone mapping, and bloom then clip the
 * framebuffer to flat white. Rescale hot lights to in-engine magnitudes.
 */
function tuneImportedPunctualLights(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Light)) return;
    const raw = child.intensity;
    if (!(raw > 80)) return;

    if (child instanceof THREE.DirectionalLight) {
      child.intensity = THREE.MathUtils.clamp(raw * 0.008, 0.35, 8);
      return;
    }
    child.intensity = THREE.MathUtils.clamp(raw * 0.004, 0.25, 26);
  });
}

function tuneGlbMaterials(
  root: THREE.Object3D,
  named: Map<string, THREE.Object3D>,
): void {
  // Knock the windshield glass down so the outside scene reads through it.
  const glass = named.get("Window_Glass") as THREE.Mesh | undefined;
  if (glass?.isMesh) {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xa9e3ff,
      transparent: true,
      opacity: 0.07,
      roughness: 0.02,
      metalness: 0,
      transmission: 0.85,
      thickness: 0.02,
      depthWrite: false,
    });
    glass.material = glassMat;
    glass.renderOrder = 5;
  }

  // Walk all materials and ease back over-bright emissives + sharpen the
  // metalness so the cockpit reads as a real spacecraft cabin under our
  // post-fx pipeline (ACES tone mapping is unforgiving of unbounded
  // emissive strength).
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const apply = (m: THREE.Material): void => {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) return;
      // KHR_materials_emissive_strength encodes high-DR emissives via
      // userData; if the value is huge, dial it back to taste so the
      // cabin doesn't bloom into a wall of light.
      if (std.emissiveIntensity != null && std.emissiveIntensity > 1.5) {
        std.emissiveIntensity = Math.min(std.emissiveIntensity, 1.4);
      }
      // Slightly raise base roughness so panels don't read like wet plastic.
      std.roughness = clamp(std.roughness ?? 0.5, 0.35, 0.95);
    };
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(apply);
    else if (mat) apply(mat);
  });
}

/**
 * Compute pilot-eye position in GLB-local coords. We average the seat
 * positions and lift the result by a typical eye height so the camera
 * sits inside the seat looking forward (-Z).
 */
function estimatePilotEye(
  named: Map<string, THREE.Object3D>,
): THREE.Vector3 {
  const tmp = new THREE.Vector3();
  // Author-placed marker (Empty) — preferred for exact framing vs. the windows.
  for (const marker of ["Pilot_Eye", "Cockpit_Camera", "Pilot_View"] as const) {
    const obj = named.get(marker);
    if (!obj) continue;
    obj.getWorldPosition(tmp);
    return tmp;
  }

  const left = named.get("Seat_Pilot_Left");
  const right = named.get("Seat_Pilot_Right");
  const eye = new THREE.Vector3();
  let count = 0;
  if (left) {
    left.getWorldPosition(tmp);
    eye.add(tmp);
    count++;
  }
  if (right) {
    right.getWorldPosition(tmp);
    eye.add(tmp);
    count++;
  }
  if (count === 0) {
    // Fallback to a sensible default for our authored asset.
    return new THREE.Vector3(0, 1.45, 0.6);
  }
  eye.multiplyScalar(1 / count);
  // Lift to head height + slight forward bias so camera sits between seats.
  eye.y += 0.78;
  eye.z += 0.04;
  return eye;
}

function readPilotEyeFovHint(node: THREE.Object3D | undefined): number | null {
  if (!node) return null;
  const u = (node.userData ?? {}) as { fov_recommended?: unknown };
  const f = u.fov_recommended;
  if (typeof f !== "number" || !Number.isFinite(f)) return null;
  return clamp(f, 35, 100);
}

/** Nudge authored eye snaps so the cockpit interior sits around the anchor. */
function applyGlbPilotEyeSnapBias(
  eye: THREE.Vector3,
  pilotExtras?: THREE.Object3D,
): void {
  let yBias = DEFAULT_GLTF_COCKPIT_SNAP_BIAS_Y;
  let fwdBias = DEFAULT_GLTF_COCKPIT_SNAP_BIAS_FWD;
  const ud = (pilotExtras?.userData ?? {}) as {
    snap_bias_y?: unknown;
    snap_bias_forward?: unknown;
  };
  if (typeof ud.snap_bias_y === "number" && Number.isFinite(ud.snap_bias_y)) {
    yBias = ud.snap_bias_y;
  }
  if (
    typeof ud.snap_bias_forward === "number" &&
    Number.isFinite(ud.snap_bias_forward)
  ) {
    fwdBias = ud.snap_bias_forward;
  }
  yBias = clamp(yBias, -2.5, 2.5);
  fwdBias = clamp(fwdBias, -2.5, 2.5);
  eye.y += yBias;
  eye.addScaledVector(_cockpitSnapShipFwd, fwdBias);
}

/**
 * Re-point the existing clickable controls at three GLB-authored MFD
 * buttons so the player can still toggle autopilot / view / headlights
 * by clicking on physical cockpit hardware. The previous procedural
 * caps are left invisible inside the hidden dynamic overlay.
 */
function retargetClickablesToGlb(
  clickables: ClickableControl[],
  named: Map<string, THREE.Object3D>,
): void {
  const targetNames = ["Btn_MFD2_top_0", "Btn_MFD2_top_2", "Btn_MFD2_bot_0"];
  for (let i = 0; i < clickables.length && i < targetNames.length; i++) {
    const node = named.get(targetNames[i]);
    if (!node) continue;
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) continue;
    const ctrl = clickables[i];
    // Replace the mesh's material with a clone we can tint per-state
    // without bleeding the change across other buttons.
    const sourceMat = mesh.material as THREE.Material | THREE.Material[];
    const baseMat = Array.isArray(sourceMat) ? sourceMat[0] : sourceMat;
    if ((baseMat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const std = (baseMat as THREE.MeshStandardMaterial).clone();
      const tint = ctrl.kind === "autopilot"
        ? 0x6cf09c
        : ctrl.kind === "view"
          ? 0x00e0ff
          : 0xffb24a;
      std.emissive = new THREE.Color(tint);
      std.emissiveIntensity = ctrl.baseEmissive;
      mesh.material = std;
    }
    ctrl.mesh = mesh;
  }
}
