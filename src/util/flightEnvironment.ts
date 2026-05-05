import * as THREE from "three";

export interface FlightEnvironment {
  group: THREE.Group;
  update(opts: {
    cameraPosition: THREE.Vector3;
    shipPosition: THREE.Vector3;
    shipForward: THREE.Vector3;
    shipVelocity: THREE.Vector3;
    speedNorm: number;
    boost: number;
    elapsedSec: number;
    deltaSec: number;
    visible: boolean;
  }): void;
  dispose(): void;
}

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute float aTwinkle;
  varying vec3 vColor;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 1.0 + sin(uTime * (0.55 + aTwinkle * 1.2) + aPhase) * 0.18 * aTwinkle;
    gl_PointSize = aSize * twinkle * uPixelRatio * (420.0 / max(220.0, abs(mvPosition.z)));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  uniform float uOpacity;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    float core = smoothstep(0.5, 0.0, d);
    float spike = max(
      smoothstep(0.48, 0.0, abs(p.x)) * smoothstep(0.08, 0.0, abs(p.y)),
      smoothstep(0.48, 0.0, abs(p.y)) * smoothstep(0.08, 0.0, abs(p.x))
    ) * 0.22;
    float a = max(core, spike);
    gl_FragColor = vec4(vColor, a * uOpacity);
  }
`;

const NEBULA_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  void main() {
    vColor = color;
    vAlpha = 0.42 + sin(uTime * 0.08 + aPhase) * 0.08;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (520.0 / max(260.0, abs(mvPosition.z)));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const NEBULA_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uOpacity;
  void main() {
    float d = distance(gl_PointCoord, vec2(0.5));
    float a = pow(1.0 - clamp(d * 2.0, 0.0, 1.0), 2.2) * vAlpha;
    gl_FragColor = vec4(vColor, a * uOpacity);
  }
`;

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _velocity = new THREE.Vector3();

export function createFlightEnvironment(): FlightEnvironment {
  const group = new THREE.Group();
  group.name = "flightEnvironment";

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const starLayers = [
    createStarLayer({ count: 5200, radius: 7600, sizeMin: 2.0, sizeMax: 5.6, warmth: 0.15 }),
    createStarLayer({ count: 3600, radius: 9000, sizeMin: 1.4, sizeMax: 4.2, warmth: 0.35 }),
    createStarLayer({ count: 1400, radius: 10300, sizeMin: 2.8, sizeMax: 7.4, warmth: 0.55 }),
  ];
  starLayers.forEach((layer) => {
    layer.points.frustumCulled = false;
    group.add(layer.points);
  });

  const nebula = createNebulaLayer();
  nebula.points.frustumCulled = false;
  group.add(nebula.points);

  const streaks = createSpeedStreaks(560);
  group.add(streaks.lines);

  const update: FlightEnvironment["update"] = ({
    cameraPosition,
    shipPosition,
    shipForward,
    shipVelocity,
    speedNorm,
    boost,
    elapsedSec,
    deltaSec,
    visible,
  }) => {
    group.visible = visible;
    if (!visible) return;

    const speed = Math.max(0, Math.min(1, speedNorm));
    const boostNorm = Math.max(0, Math.min(1, boost));
    starLayers.forEach((layer, idx) => {
      const drift = (idx + 1) * 0.08;
      layer.points.position
        .copy(cameraPosition)
        .add(_velocity.copy(shipVelocity).multiplyScalar(-drift));
      layer.points.rotation.y += deltaSec * (0.0004 + idx * 0.00025);
      layer.material.uniforms.uTime.value = elapsedSec;
      layer.material.uniforms.uPixelRatio.value = pixelRatio;
      layer.material.uniforms.uOpacity.value = layer.baseOpacity + speed * 0.10 + boostNorm * 0.04;
    });

    nebula.points.position
      .copy(cameraPosition)
      .add(_offset.copy(shipForward).multiplyScalar(-180));
    nebula.points.rotation.y = elapsedSec * 0.004;
    nebula.material.uniforms.uTime.value = elapsedSec;
    nebula.material.uniforms.uPixelRatio.value = pixelRatio;
    nebula.material.uniforms.uOpacity.value = 0.18 + speed * 0.10;

    streaks.update(shipPosition, shipForward, speed, boostNorm);
  };

  const dispose = () => {
    starLayers.forEach((layer) => {
      layer.points.geometry.dispose();
      layer.material.dispose();
    });
    nebula.points.geometry.dispose();
    nebula.material.dispose();
    streaks.lines.geometry.dispose();
    streaks.material.dispose();
  };

  return { group, update, dispose };
}

function createStarLayer(opts: {
  count: number;
  radius: number;
  sizeMin: number;
  sizeMax: number;
  warmth: number;
}): { points: THREE.Points; material: THREE.ShaderMaterial; baseOpacity: number } {
  const positions = new Float32Array(opts.count * 3);
  const colors = new Float32Array(opts.count * 3);
  const sizes = new Float32Array(opts.count);
  const phases = new Float32Array(opts.count);
  const twinkles = new Float32Array(opts.count);

  for (let i = 0; i < opts.count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = opts.radius * (0.9 + Math.random() * 0.1);
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const mag = Math.pow(Math.random(), 2.2);
    sizes[i] = opts.sizeMin + (opts.sizeMax - opts.sizeMin) * mag;
    phases[i] = Math.random() * Math.PI * 2;
    twinkles[i] = Math.random();

    const temp = Math.random();
    const warm = new THREE.Color(1.0, 0.82, 0.58);
    const cool = new THREE.Color(0.62, 0.82, 1.0);
    const white = new THREE.Color(1, 1, 1);
    const c = white
      .clone()
      .lerp(temp < opts.warmth ? warm : cool, 0.22 + Math.random() * 0.22)
      .multiplyScalar(0.55 + mag * 0.55);
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aTwinkle", new THREE.BufferAttribute(twinkles, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uOpacity: { value: 0.7 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return {
    points: new THREE.Points(geometry, material),
    material,
    baseOpacity: 0.62 + Math.random() * 0.12,
  };
}

function createNebulaLayer(): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const count = 220;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const lane = (Math.random() - 0.5) * 0.45;
    const theta = Math.random() * Math.PI * 2;
    const radius = 8800 + Math.random() * 1200;
    positions[i * 3 + 0] = Math.cos(theta) * radius;
    positions[i * 3 + 1] = lane * radius + (Math.random() - 0.5) * 380;
    positions[i * 3 + 2] = Math.sin(theta) * radius;
    sizes[i] = 180 + Math.random() * 520;
    phases[i] = Math.random() * Math.PI * 2;

    const c = new THREE.Color(0x5eb8ff)
      .lerp(new THREE.Color(0xff8f6a), Math.random() * 0.38)
      .multiplyScalar(0.35 + Math.random() * 0.25);
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uOpacity: { value: 0.2 },
    },
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    vertexColors: true,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return { points: new THREE.Points(geometry, material), material };
}

function createSpeedStreaks(count: number): {
  lines: THREE.LineSegments;
  material: THREE.LineBasicMaterial;
  update(shipPosition: THREE.Vector3, shipForward: THREE.Vector3, speedNorm: number, boost: number): void;
} {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 6);
  const offsets = new Float32Array(count * 3);
  const forward = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    seedStreak(i, offsets, forward, 7, 170);
    const tint = 0.45 + Math.random() * 0.55;
    colors[i * 6 + 0] = 0.25 * tint;
    colors[i * 6 + 1] = 0.75 * tint;
    colors[i * 6 + 2] = 1.0 * tint;
    colors[i * 6 + 3] = 0.05 * tint;
    colors[i * 6 + 4] = 0.38 * tint;
    colors[i * 6 + 5] = 0.85 * tint;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.name = "flightEnvironment.speedStreaks";

  const update = (
    shipPosition: THREE.Vector3,
    shipForward: THREE.Vector3,
    speedNorm: number,
    boost: number,
  ) => {
    const speed = Math.max(0, Math.min(1, speedNorm));
    material.opacity = Math.min(0.92, Math.max(0, (speed - 0.15) / 0.85) * (0.32 + boost * 0.25));
    if (material.opacity <= 0.001) return;

    const fwd = _offset.copy(shipForward).normalize();
    const refUp = Math.abs(fwd.y) > 0.95 ? _up.set(0, 0, 1) : _up.set(0, 1, 0);
    _right.crossVectors(fwd, refUp).normalize();
    _up.crossVectors(_right, fwd).normalize();

    const arr = positions;
    const lineLen = 3 + speed * 28 + boost * 16;
    const radius = 10 + speed * 9;
    const length = 190 + speed * 120;
    for (let i = 0; i < count; i++) {
      forward[i] -= 1.8 + speed * 6.5 + boost * 5.0;
      if (forward[i] < -length * 0.5) {
        seedStreak(i, offsets, forward, radius, length);
      }
      const ox = offsets[i * 3 + 0];
      const oy = offsets[i * 3 + 1];
      const oz = offsets[i * 3 + 2];
      const baseX = shipPosition.x + fwd.x * forward[i] + _right.x * ox + _up.x * oy + fwd.x * oz * 0.02;
      const baseY = shipPosition.y + fwd.y * forward[i] + _right.y * ox + _up.y * oy + fwd.y * oz * 0.02;
      const baseZ = shipPosition.z + fwd.z * forward[i] + _right.z * ox + _up.z * oy + fwd.z * oz * 0.02;
      const o = i * 6;
      arr[o] = baseX;
      arr[o + 1] = baseY;
      arr[o + 2] = baseZ;
      arr[o + 3] = baseX + fwd.x * lineLen;
      arr[o + 4] = baseY + fwd.y * lineLen;
      arr[o + 5] = baseZ + fwd.z * lineLen;
    }
    geometry.attributes.position.needsUpdate = true;
  };

  return { lines, material, update };
}

function seedStreak(
  i: number,
  offsets: Float32Array,
  forward: Float32Array,
  radius: number,
  length: number,
): void {
  const r = Math.sqrt(Math.random()) * radius;
  const a = Math.random() * Math.PI * 2;
  offsets[i * 3 + 0] = Math.cos(a) * r;
  offsets[i * 3 + 1] = Math.sin(a) * r;
  offsets[i * 3 + 2] = (Math.random() - 0.5) * radius;
  forward[i] = -length * 0.45 + Math.random() * length;
}
