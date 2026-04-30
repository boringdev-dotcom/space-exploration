import * as THREE from "three";

/**
 * Streaming "space dust" particle field used to sell the sensation of motion
 * out of the cockpit window. Particles live in a thin cylinder around the
 * ship's forward axis; whenever a particle drifts behind the ship (or
 * outside the cylinder) it gets respawned ahead of the ship.
 *
 * This is purely cosmetic — it doesn't affect gameplay or telemetry — but
 * it's the single biggest "feel" lever for making cruise read as actually
 * moving instead of "parked in space".
 */
export interface SpaceDust {
  points: THREE.Points;
  /**
   * Call once per frame with the ship's current world pos + forward axis.
   * `speedNorm` (0..1) intensifies size + opacity for the "fast" feeling.
   */
  update(
    shipPos: THREE.Vector3,
    shipFwd: THREE.Vector3,
    dt: number,
    speedNorm?: number,
  ): void;
  dispose(): void;
}

export interface SpaceDustOpts {
  /** How many particles. Cheap; 600 is barely a blip on perf. */
  count?: number;
  /** Cylinder radius around the ship-forward axis. */
  radius?: number;
  /** Total length of the cylinder along ship-forward (centred on ship). */
  length?: number;
  /** Particle base size (world units). */
  size?: number;
  /** Particle colour. */
  color?: number;
}

const _scratchOffset = new THREE.Vector3();
const _scratchRight = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();

export function createSpaceDust(opts: SpaceDustOpts = {}): SpaceDust {
  const count = opts.count ?? 600;
  const radius = opts.radius ?? 6;
  const length = opts.length ?? 120;
  const size = opts.size ?? 0.06;
  const color = opts.color ?? 0x9ee6ff;

  // Particle positions are stored in WORLD space, not ship-local. We
  // re-spawn behind→ahead of the ship using the ship's forward axis each
  // frame, which lets the ship's own velocity sweep them past.
  const positions = new Float32Array(count * 3);

  // Initial scatter: random positions in a cylinder around origin (we
  // immediately recentre on the ship in the first update call).
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(Math.random()) * radius;
    const a = Math.random() * Math.PI * 2;
    const fwd = (Math.random() - 0.5) * length;
    positions[i * 3 + 0] = Math.cos(a) * r;
    positions[i * 3 + 1] = Math.sin(a) * r;
    positions[i * 3 + 2] = fwd;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );
  // Skip frustum culling — particles cover a moving cylinder that the
  // bounding sphere can't track without per-frame recompute.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    color,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "spaceDust";
  points.frustumCulled = false;

  const halfLen = length / 2;

  const baseSize = size;
  const baseOpacity = 0.55;

  const update: SpaceDust["update"] = (shipPos, shipFwd, _dt, speedNorm = 0) => {
    // Visual speed cue (B4): both particle size and opacity climb with
    // ship speed so cruise doesn't feel like idle. Cheap material tweak,
    // no buffer mutation.
    const sNorm = Math.max(0, Math.min(1, speedNorm));
    material.size = baseSize * (1 + sNorm * 1.6);
    material.opacity = Math.min(0.95, baseOpacity + sNorm * 0.4);
    // Build a frame around shipFwd: pick a stable up to derive right, then
    // recover the up.
    const fwd = _scratchOffset.copy(shipFwd).normalize();
    if (fwd.lengthSq() < 0.0001) return;
    // Stable up — fall back if forward is near world Y.
    const refUp =
      Math.abs(fwd.y) > 0.95
        ? _scratchUp.set(0, 0, 1)
        : _scratchUp.set(0, 1, 0);
    const right = _scratchRight.crossVectors(fwd, refUp).normalize();
    const up = _scratchUp.crossVectors(right, fwd).normalize();

    const arr = positions;
    for (let i = 0; i < count; i++) {
      const px = arr[i * 3 + 0];
      const py = arr[i * 3 + 1];
      const pz = arr[i * 3 + 2];

      // Vector from ship to particle.
      const dx = px - shipPos.x;
      const dy = py - shipPos.y;
      const dz = pz - shipPos.z;

      // Project onto ship-fwd. Negative => particle behind ship.
      const fwdProj = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      // Radial distance in ship-fwd-perpendicular plane.
      const rx = dx - fwd.x * fwdProj;
      const ry = dy - fwd.y * fwdProj;
      const rz = dz - fwd.z * fwdProj;
      const radial2 = rx * rx + ry * ry + rz * rz;

      const outOfBand =
        fwdProj < -halfLen ||
        fwdProj > halfLen ||
        radial2 > radius * radius;

      if (outOfBand) {
        // Respawn ahead of the ship in the cylinder.
        const r = Math.sqrt(Math.random()) * radius;
        const a = Math.random() * Math.PI * 2;
        const ahead = halfLen * (0.5 + Math.random() * 0.5); // 50–100% of front half
        const ox = right.x * Math.cos(a) * r + up.x * Math.sin(a) * r;
        const oy = right.y * Math.cos(a) * r + up.y * Math.sin(a) * r;
        const oz = right.z * Math.cos(a) * r + up.z * Math.sin(a) * r;
        arr[i * 3 + 0] = shipPos.x + fwd.x * ahead + ox;
        arr[i * 3 + 1] = shipPos.y + fwd.y * ahead + oy;
        arr[i * 3 + 2] = shipPos.z + fwd.z * ahead + oz;
      }
    }

    geometry.attributes.position.needsUpdate = true;
  };

  const dispose = (): void => {
    geometry.dispose();
    material.dispose();
  };

  return { points, update, dispose };
}
