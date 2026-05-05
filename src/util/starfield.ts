import * as THREE from "three";

export interface StarfieldOptions {
  count?: number;
  radius?: number;
  size?: number;
  twinkle?: boolean;
}

/** Builds a `THREE.Points` cloud of distant stars on a sphere. */
export function createStarfield(opts: StarfieldOptions = {}): THREE.Points {
  const { count = 4000, radius = 800, size = 1.6, twinkle = false } = opts;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // uniform direction on a sphere
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.85 + Math.random() * 0.15);

    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const magnitude = twinkle
      ? Math.pow(Math.random(), 1.8) * 0.55 + 0.45
      : 0.7 + Math.random() * 0.3;
    const tint = magnitude;
    const blueShift = Math.random() < 0.15 ? 1.15 : 1;
    colors[i * 3 + 0] = tint;
    colors[i * 3 + 1] = tint;
    colors[i * 3 + 2] = Math.min(1, tint * blueShift);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Points(geometry, material);
}

/** Streaks for warp/in-flight scene — thin lines aligned with -Z. */
export function createWarpStreaks(count = 1200, length = 60): THREE.LineSegments {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 6);

  for (let i = 0; i < count; i++) {
    const r = 30 + Math.random() * 220;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const z = -Math.random() * 600;

    positions[i * 6 + 0] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = z + length;

    const tint = 0.6 + Math.random() * 0.4;
    colors[i * 6 + 0] = 0.25 * tint;
    colors[i * 6 + 1] = 0.95 * tint;
    colors[i * 6 + 2] = 1.0 * tint;
    colors[i * 6 + 3] = 0.05 * tint;
    colors[i * 6 + 4] = 0.5 * tint;
    colors[i * 6 + 5] = 0.85 * tint;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  return new THREE.LineSegments(geom, mat);
}
