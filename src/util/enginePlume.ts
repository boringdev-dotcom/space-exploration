import * as THREE from "three";

import { clamp, easeOutCubic } from "./feel";

/**
 * Layered engine plume: inner core cone + mid noise plume + outer billboard
 * haze + a trailing particle stream. Built to read well on bloom — every
 * material is additive, the inner core is a saturated cyan, the outer haze
 * is a softer warm-edged white. Throttle and boost both modulate intensity.
 *
 * The whole thing lives in a single `THREE.Group` you can parent to the
 * rocket. Origin is the engine bell exit; +Y is "up the rocket", -Y is
 * "down/behind" (the plume's natural fire direction).
 */
export interface EnginePlume {
  group: THREE.Group;
  /** Set throttle 0..2 and boost 0..1 every frame; visuals follow smoothly. */
  setState(throttle: number, boost: number): void;
  update(deltaSec: number, elapsedSec: number): void;
  dispose(): void;
}

const PLUME_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vY;
  void main() {
    vUv = uv;
    vY = position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLUME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uThrottle;
  uniform float uBoost;
  varying vec2 vUv;
  varying float vY;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.05; a *= 0.5; }
    return v;
  }

  void main() {
    // y goes 0 (top, near engine) → 1 (bottom, far end of plume)
    float t = clamp(vUv.y, 0.0, 1.0);
    // Radial falloff from cone's central axis.
    float r = abs(vUv.x - 0.5) * 2.0;

    // Scrolling FBM for noisy plume body.
    float n = fbm(vec2(vUv.x * 4.0, vUv.y * 8.0 - uTime * 4.5));
    float plume = pow(1.0 - r, 1.8) * (0.55 + 0.45 * n);

    // Length envelope: long when throttling + boosting, short at idle.
    float lengthMul = mix(0.55, 1.6, clamp(uThrottle * 0.5, 0.0, 1.0));
    lengthMul += uBoost * 0.6;
    float lengthFalloff = smoothstep(lengthMul, 0.0, t);
    plume *= lengthFalloff;

    // Color ramp: white-cyan core → cooler cyan body → faint blue tail.
    vec3 core = vec3(0.85, 0.99, 1.00);
    vec3 body = vec3(0.32, 0.84, 1.00);
    vec3 tail = vec3(0.08, 0.30, 0.72);
    vec3 col = mix(body, core, smoothstep(0.45, 0.0, r) * (1.0 - t * 0.7));
    col = mix(col, tail, smoothstep(0.55, 1.0, t));

    // Boost dial: punch saturation + nudge core warmer.
    col = mix(col, col + vec3(0.25, 0.05, -0.10) * uBoost, uBoost * 0.5);

    float alpha = plume * (0.55 + 0.45 * uThrottle * 0.5);
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createEnginePlume(opts: {
  /** Length of the plume along -Y (in world units at scale 1). */
  length?: number;
  /** Radius of the plume base (where it meets the engine bell). */
  baseRadius?: number;
} = {}): EnginePlume {
  const length = opts.length ?? 6;
  const baseRadius = opts.baseRadius ?? 0.55;

  const group = new THREE.Group();
  group.name = "enginePlume";

  // Mid plume — a tall cone with a custom shader. The cone points down -Y.
  const midGeom = new THREE.ConeGeometry(baseRadius * 1.6, length, 22, 14, true);
  midGeom.translate(0, -length / 2, 0);
  const midMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 1 },
      uBoost: { value: 0 },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mid = new THREE.Mesh(midGeom, midMat);
  mid.name = "enginePlume.mid";
  group.add(mid);

  // Inner core — short, intense, white-cyan.
  const coreGeom = new THREE.ConeGeometry(baseRadius * 0.55, length * 0.42, 18, 1, true);
  coreGeom.translate(0, -length * 0.21, 0);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xd6f9ff,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const core = new THREE.Mesh(coreGeom, coreMat);
  core.name = "enginePlume.core";
  group.add(core);

  // Outer haze — billboard, radial gradient. Stays facing the camera.
  const hazeGeom = new THREE.CircleGeometry(baseRadius * 3.6, 32);
  const hazeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x7adcff) },
      uIntensity: { value: 0.6 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uIntensity;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float a = pow(1.0 - clamp(d * 2.0, 0.0, 1.0), 2.4);
        gl_FragColor = vec4(uColor, a * uIntensity);
      }
    `,
  });
  const haze = new THREE.Mesh(hazeGeom, hazeMat);
  haze.name = "enginePlume.haze";
  haze.position.set(0, -length * 0.65, 0);
  haze.rotation.x = -Math.PI / 2;
  group.add(haze);

  // Lingering particle trail. Positions live in a ring buffer; on every
  // emission step we reset the oldest particles to the engine origin.
  const PARTICLE_COUNT = 320;
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const lives = new Float32Array(PARTICLE_COUNT);
  const seeds = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    lives[i] = Math.random() * 1.5;
    seeds[i] = Math.random();
  }
  const pGeom = new THREE.BufferGeometry();
  pGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const pMat = new THREE.PointsMaterial({
    size: 0.18,
    color: 0x9ee6ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(pGeom, pMat);
  points.name = "enginePlume.particles";
  // Particles live in the SHIP-LOCAL frame, not the plume's. We let the
  // rocket "leave them behind" by reparenting handled outside; for the
  // self-contained module we keep them inside the group, accepting the
  // small artistic cost (they bob with the plume but still read as exhaust).
  group.add(points);

  let throttle = 1;
  let boost = 0;

  const setState = (t: number, b: number) => {
    throttle = clamp(t, 0, 2);
    boost = clamp(b, 0, 1);
  };

  const update = (deltaSec: number, elapsedSec: number) => {
    const tNorm = throttle / 2; // 0..1
    midMat.uniforms.uTime.value = elapsedSec;
    midMat.uniforms.uThrottle.value = throttle;
    midMat.uniforms.uBoost.value = boost;

    // Core flicker — cheap sin-noise, scaled by throttle.
    const flicker = 0.85 + Math.random() * 0.15;
    coreMat.opacity = (0.55 + tNorm * 0.45) * flicker;
    core.scale.set(
      0.92 + Math.random() * 0.08,
      easeOutCubic(0.4 + tNorm * 0.6) * (1 + boost * 0.4),
      0.92 + Math.random() * 0.08,
    );

    // Haze pulses softly with throttle and grows on boost.
    hazeMat.uniforms.uIntensity.value = 0.35 + tNorm * 0.4 + boost * 0.4;
    const hazeScale = 0.85 + tNorm * 0.5 + boost * 0.45;
    haze.scale.setScalar(hazeScale);

    // Particle stream — emit and propagate.
    const emitCount = Math.floor((20 + boost * 40) * deltaSec * 60);
    let emitted = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      lives[i] -= deltaSec;
      const o = i * 3;
      if (lives[i] <= 0 && emitted < emitCount) {
        positions[o] = (Math.random() - 0.5) * baseRadius * 0.4;
        positions[o + 1] = -baseRadius * 0.3 - Math.random() * baseRadius * 0.3;
        positions[o + 2] = (Math.random() - 0.5) * baseRadius * 0.4;
        lives[i] = 0.7 + Math.random() * 1.1;
        emitted++;
      } else if (lives[i] > 0) {
        const fall = (1.6 + boost * 1.4 + tNorm * 1.2) * deltaSec;
        positions[o + 1] -= fall;
        positions[o] += (seeds[i] - 0.5) * 0.04 * deltaSec;
        positions[o + 2] += (Math.random() - 0.5) * 0.04 * deltaSec;
      } else {
        // Park dead particles outside view.
        positions[o + 1] = -1e6;
      }
    }
    (pGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    pMat.opacity = 0.6 + tNorm * 0.3 + boost * 0.2;
  };

  const dispose = () => {
    midGeom.dispose();
    midMat.dispose();
    coreGeom.dispose();
    coreMat.dispose();
    hazeGeom.dispose();
    hazeMat.dispose();
    pGeom.dispose();
    pMat.dispose();
  };

  return { group, setState, update, dispose };
}
