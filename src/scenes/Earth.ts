import * as THREE from "three";

import { disposeObjectTree, loadNormalizedGltfModel } from "../util/gltfModel";

/**
 * Mission-scale Earth: photoreal GLB body + procedural animated cloud shell
 * + back-side atmosphere halo. All in one reusable group with a `dispose()`
 * for cleanup.
 *
 * The GLB at [public/models/earth/earth.glb](public/models/earth/earth.glb)
 * provides photoreal continents/oceans the procedural shader can't match
 * up close during liftoff. The cloud + atmosphere shells layer on top to
 * sell motion (clouds drift) and depth (rim glow) cheaply.
 *
 * Scale: 1 unit = 100 km. Radius 63.78 units (real Earth radius).
 */

export const EARTH_RADIUS = 63.78;
export const EARTH_CLOUD_RADIUS = 64.45;
export const EARTH_ATMOSPHERE_RADIUS = 72;
const EARTH_GLB_URL = "/models/earth/earth.glb";

export interface Earth {
  group: THREE.Group;
  /** Drive each frame with the elapsed seconds; rotates body + clouds. */
  update(deltaSec: number, elapsedSec: number): void;
  /** Set the sun direction (world space, normalized). Drives cloud shading. */
  setSunDirection(dir: THREE.Vector3): void;
  /** Free GPU resources. */
  dispose(): void;
  /** True once the GLB body has resolved (or fell back to procedural). */
  readonly ready: Promise<void>;
}

const CLOUD_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  varying vec3 vNormal;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash(i), b = hash(i+vec2(1,0));
    float c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
  }
  float fbm(vec2 p) {
    float v=0.0, a=0.5;
    for (int i=0;i<3;i++) { v+=a*vnoise(p); p*=2.1; a*=0.5; }
    return v;
  }
  void main() {
    vec3 N = normalize(vNormal);
    vec2 uv = vec2(atan(N.z,N.x)/6.2831853+0.5, asin(clamp(N.y,-1.0,1.0))/3.1415927+0.5);
    float c = fbm(uv * vec2(6.0, 3.0) + vec2(uTime*0.04, 0.0));
    float a = smoothstep(0.50, 0.78, c);
    float sun = clamp(dot(N, normalize(uSunDir)), 0.0, 1.0);
    vec3 col = mix(vec3(0.08), vec3(1.0), 0.4 + 0.6 * sun);
    gl_FragColor = vec4(col, a * 0.55);
  }
`;

const VERT = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMOSPHERE_FRAG = /* glsl */ `
  varying vec3 vNormal;
  uniform vec3 uColor;
  void main() {
    float i = pow(0.62 - dot(vNormal, vec3(0,0,1)), 2.4);
    gl_FragColor = vec4(uColor, 1.0) * i;
  }
`;

export function createEarth(): Earth {
  const group = new THREE.Group();
  group.name = "earth";

  // Body — placeholder procedural sphere shown until the GLB resolves.
  const placeholderGeom = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
  const placeholderMat = new THREE.MeshStandardMaterial({
    color: 0x274a6e,
    roughness: 0.85,
    metalness: 0.05,
    emissive: 0x0a1420,
    emissiveIntensity: 0.4,
  });
  const placeholder = new THREE.Mesh(placeholderGeom, placeholderMat);
  placeholder.name = "earth.placeholder";
  group.add(placeholder);

  let glbBody: THREE.Group | null = null;

  // Cloud shell — slowly rotating, additive.
  const cloudUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(1, 0.3, 0.5).normalize() },
  };
  const cloudMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: cloudUniforms,
    vertexShader: VERT,
    fragmentShader: CLOUD_FRAG,
  });
  const cloudGeom = new THREE.SphereGeometry(EARTH_CLOUD_RADIUS, 96, 96);
  const clouds = new THREE.Mesh(cloudGeom, cloudMat);
  clouds.name = "earth.clouds";
  group.add(clouds);

  // Back-side atmosphere halo.
  const atmosphereMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: { uColor: { value: new THREE.Color(0x6cc7ff) } },
    vertexShader: VERT,
    fragmentShader: ATMOSPHERE_FRAG,
  });
  const atmosphereGeom = new THREE.SphereGeometry(EARTH_ATMOSPHERE_RADIUS, 64, 64);
  const atmosphere = new THREE.Mesh(atmosphereGeom, atmosphereMat);
  atmosphere.name = "earth.atmosphere";
  group.add(atmosphere);

  let bodyForRotation: THREE.Object3D = placeholder;

  const ready = (async () => {
    try {
      // Diameter = 2 x radius. The GLB is normalized so its longest axis
      // matches `targetDiameter`.
      const glb = await loadNormalizedGltfModel(EARTH_GLB_URL, EARTH_RADIUS * 2);
      // Many Earth GLBs ship with PBR materials that look fine under any
      // light setup; we just make sure none of them are double-sided so the
      // cloud shell composites cleanly.
      glb.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.frustumCulled = false;
          const m = mesh.material as THREE.MeshStandardMaterial;
          if (m && "side" in m) m.side = THREE.FrontSide;
        }
      });
      glbBody = glb;
      group.remove(placeholder);
      placeholderGeom.dispose();
      placeholderMat.dispose();
      group.add(glbBody);
      bodyForRotation = glbBody;
    } catch (err) {
      console.warn(
        "[Earth] GLB load failed, keeping procedural placeholder",
        err,
      );
    }
  })();

  const update = (_dt: number, elapsedSec: number) => {
    cloudUniforms.uTime.value = elapsedSec;
    // Slow rotation — Earth looks alive but doesn't induce nausea.
    bodyForRotation.rotation.y = elapsedSec * 0.012;
    clouds.rotation.y = elapsedSec * 0.018;
  };

  const setSunDirection = (dir: THREE.Vector3) => {
    cloudUniforms.uSunDir.value.copy(dir).normalize();
  };

  const dispose = () => {
    cloudGeom.dispose();
    cloudMat.dispose();
    atmosphereGeom.dispose();
    atmosphereMat.dispose();
    if (glbBody) {
      disposeObjectTree(glbBody);
    } else {
      placeholderGeom.dispose();
      placeholderMat.dispose();
    }
  };

  return { group, update, setSunDirection, dispose, ready };
}
