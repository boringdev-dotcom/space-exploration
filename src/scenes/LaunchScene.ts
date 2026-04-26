import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { SceneSlot } from "./Scene";
import { createStarfield } from "../util/starfield";

/**
 * Earth-orbit launch scene. Used for the LAUNCH and DESTINATION SELECT states.
 * Features:
 *  - day/night terminator shader on Earth with city-light glow
 *  - rotating cloud layer
 *  - back-side atmospheric scattering halo
 *  - draggable OrbitControls with auto-rotate when idle
 *  - rocket with additive exhaust particles
 */
export class LaunchScene implements SceneSlot {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;

  private earth: THREE.Mesh;
  private earthMat: THREE.ShaderMaterial;
  private clouds: THREE.Mesh;
  private atmosphere: THREE.Mesh;
  private rocket: THREE.Group;
  private starfield: THREE.Points;
  private sun: THREE.DirectionalLight;
  private controls: OrbitControls;

  private exhaust: THREE.Points;
  private exhaustVel: Float32Array;
  private exhaustLife: Float32Array;

  private idleTimerSec = 0;
  private interacted = false;

  constructor(domElement: HTMLElement) {
    this.domElement = domElement;
    this.camera = new THREE.PerspectiveCamera(
      48,
      window.innerWidth / window.innerHeight,
      0.05,
      4000,
    );
    this.camera.position.set(0, 1.6, 9.5);

    // Lighting: a warm sun + cool ambient fill.
    this.sun = new THREE.DirectionalLight(0xffe7c4, 3.0);
    this.sun.position.set(8, 3, 5);
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x223344, 0.25));

    // Stars
    this.starfield = createStarfield({ count: 8000, radius: 1400 });
    this.scene.add(this.starfield);

    // Earth — custom shader for day/night terminator + city lights
    const earthGeom = new THREE.SphereGeometry(2.6, 128, 128);
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0.3, 0.5).normalize() },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying vec2 vUv;

        // 2D hash + value noise for procedural continents.
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            p *= 2.07;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          // Spherical UV from normal (independent of mesh seam).
          vec3 N = normalize(vNormal);
          vec2 sphUv = vec2(
            atan(N.z, N.x) / 6.2831853 + 0.5,
            asin(clamp(N.y, -1.0, 1.0)) / 3.1415927 + 0.5
          );

          // Continents.
          float landNoise = fbm(sphUv * vec2(8.0, 4.0));
          float land = smoothstep(0.55, 0.62, landNoise);
          vec3 ocean = mix(vec3(0.02, 0.10, 0.25), vec3(0.05, 0.22, 0.42), landNoise * 0.6);
          vec3 landCol = mix(vec3(0.13, 0.30, 0.10), vec3(0.45, 0.40, 0.22),
                             smoothstep(0.6, 0.85, landNoise));
          // Ice caps near poles
          float pole = smoothstep(0.78, 0.95, abs(N.y));
          landCol = mix(landCol, vec3(0.93, 0.96, 1.0), pole);
          ocean = mix(ocean, vec3(0.92, 0.96, 1.0), pole * 0.7);
          vec3 day = mix(ocean, landCol, land);

          // Night side: dim base + city lights on land
          float cityNoise = fbm(sphUv * vec2(40.0, 20.0));
          float cities = smoothstep(0.62, 0.78, cityNoise) * land;
          vec3 night = mix(vec3(0.005, 0.01, 0.02), vec3(1.0, 0.65, 0.25), cities * 1.4);

          // Sun-side blend
          float sun = dot(N, normalize(uSunDir));
          float dayMix = smoothstep(-0.15, 0.25, sun);
          vec3 col = mix(night, day * (0.4 + dayMix * 0.6), dayMix);

          // Rim/atmosphere highlight on day-side limb
          float rim = pow(1.0 - max(0.0, dot(N, vec3(0.0, 0.0, 1.0))), 3.0);
          col += vec3(0.20, 0.55, 0.85) * rim * dayMix * 0.8;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.earth = new THREE.Mesh(earthGeom, this.earthMat);
    this.scene.add(this.earth);

    // Animated cloud layer (additive, slowly rotating).
    const cloudGeom = new THREE.SphereGeometry(2.66, 96, 96);
    const cloudMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: this.earthMat.uniforms.uSunDir.value },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
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
      `,
    });
    this.clouds = new THREE.Mesh(cloudGeom, cloudMat);
    this.scene.add(this.clouds);

    // Atmosphere halo (back-side rim).
    const atmGeom = new THREE.SphereGeometry(2.95, 64, 64);
    const atmMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uColor: { value: new THREE.Color(0x6cc7ff) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vNormal;
        uniform vec3 uColor;
        void main() {
          float i = pow(0.62 - dot(vNormal, vec3(0,0,1)), 2.4);
          gl_FragColor = vec4(uColor, 1.0) * i;
        }
      `,
    });
    this.atmosphere = new THREE.Mesh(atmGeom, atmMat);
    this.scene.add(this.atmosphere);

    this.rocket = this.buildRocket();
    this.scene.add(this.rocket);

    // Particle exhaust trail
    const exhaustCount = 240;
    const exhaustPos = new Float32Array(exhaustCount * 3);
    const exhaustCol = new Float32Array(exhaustCount * 3);
    this.exhaustVel = new Float32Array(exhaustCount * 3);
    this.exhaustLife = new Float32Array(exhaustCount);
    for (let i = 0; i < exhaustCount; i++) {
      this.exhaustLife[i] = Math.random() * 1.5;
      exhaustCol[i * 3] = 0.4 + Math.random() * 0.4;
      exhaustCol[i * 3 + 1] = 0.95;
      exhaustCol[i * 3 + 2] = 1.0;
    }
    const exhaustGeom = new THREE.BufferGeometry();
    exhaustGeom.setAttribute("position", new THREE.BufferAttribute(exhaustPos, 3));
    exhaustGeom.setAttribute("color", new THREE.BufferAttribute(exhaustCol, 3));
    const exhaustMat = new THREE.PointsMaterial({
      size: 0.05,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.exhaust = new THREE.Points(exhaustGeom, exhaustMat);
    this.scene.add(this.exhaust);

    // OrbitControls with damping + auto-rotate when idle.
    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 5.5;
    this.controls.maxDistance = 18;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener("start", () => {
      this.interacted = true;
      this.idleTimerSec = 0;
      this.controls.autoRotate = false;
    });
    this.controls.update();
  }

  enter(): void {
    this.controls.enabled = true;
  }
  exit(): void {
    this.controls.enabled = false;
  }

  update(delta: number, elapsed: number): void {
    this.earth.rotation.y += delta * 0.025;
    this.clouds.rotation.y += delta * 0.04;
    this.starfield.rotation.y += delta * 0.0015;

    (this.earthMat.uniforms.uTime as { value: number }).value = elapsed;
    const cloudUniforms = (this.clouds.material as THREE.ShaderMaterial).uniforms;
    (cloudUniforms.uTime as { value: number }).value = elapsed;

    // Idle → resume slow auto-rotate.
    this.idleTimerSec += delta;
    if (this.interacted && this.idleTimerSec > 4) {
      this.controls.autoRotate = true;
    }

    this.controls.update();

    // Rocket bob and exhaust emission
    const bob = Math.sin(elapsed * 1.6) * 0.05;
    this.rocket.position.set(2.4, 1.5 + bob, 1.3);
    this.rocket.lookAt(new THREE.Vector3(8, 8, 6));

    const flame = this.rocket.getObjectByName("flame") as THREE.Mesh | undefined;
    if (flame) {
      const mat = flame.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.6 + Math.random() * 0.3;
      flame.scale.y = 0.9 + Math.random() * 0.3;
    }

    this.updateExhaust(delta);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.controls.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
      else m?.dispose?.();
    });
  }

  /* Camera presets */

  frameEarth(): void {
    this.tweenTarget(this.camera.position, new THREE.Vector3(0, 1.6, 9.5), 0.1);
    this.controls.minDistance = 5.5;
    this.controls.maxDistance = 18;
  }

  frameOrbit(): void {
    this.tweenTarget(this.camera.position, new THREE.Vector3(0, 2.4, 13), 0.08);
  }

  /* Helpers */

  private tweenTarget(_pos: THREE.Vector3, target: THREE.Vector3, speed: number): void {
    // Lerp on next frames inside update; cheap implementation: nudge toward target.
    this.camera.position.lerp(target, Math.min(1, speed));
  }

  private updateExhaust(delta: number): void {
    const positions = (this.exhaust.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(this.rocket.quaternion);
    const tail = new THREE.Vector3(0, -0.78, 0)
      .applyQuaternion(this.rocket.quaternion)
      .add(this.rocket.position);

    for (let i = 0; i < this.exhaustLife.length; i++) {
      this.exhaustLife[i] -= delta;
      const o = i * 3;
      if (this.exhaustLife[i] <= 0) {
        // Spawn at rocket tail
        positions[o] = tail.x + (Math.random() - 0.5) * 0.04;
        positions[o + 1] = tail.y + (Math.random() - 0.5) * 0.04;
        positions[o + 2] = tail.z + (Math.random() - 0.5) * 0.04;
        this.exhaustVel[o] = dir.x * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.05;
        this.exhaustVel[o + 1] = dir.y * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.05;
        this.exhaustVel[o + 2] = dir.z * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.05;
        this.exhaustLife[i] = 0.6 + Math.random() * 0.8;
      } else {
        positions[o] += this.exhaustVel[o] * delta;
        positions[o + 1] += this.exhaustVel[o + 1] * delta;
        positions[o + 2] += this.exhaustVel[o + 2] * delta;
      }
    }
    (this.exhaust.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private buildRocket(): THREE.Group {
    const group = new THREE.Group();
    group.name = "rocket";

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xeef3f7,
      metalness: 0.7,
      roughness: 0.3,
      emissive: 0x111921,
      emissiveIntensity: 0.25,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x00f3ff,
      metalness: 0.2,
      roughness: 0.4,
      emissive: 0x00f3ff,
      emissiveIntensity: 1.6,
    });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 1.0, 32), bodyMat);
    group.add(body);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 32), bodyMat);
    nose.position.y = 0.72;
    group.add(nose);

    // Two glowing accent rings
    [0.1, -0.15].forEach((y) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.012, 8, 32), accentMat);
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    });

    // Fins
    const finGeom = new THREE.BoxGeometry(0.04, 0.32, 0.22);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(finGeom, bodyMat);
      const a = (i / 3) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 0.18, -0.4, Math.sin(a) * 0.18);
      fin.lookAt(0, fin.position.y, 0);
      group.add(fin);
    }

    // Flame cone
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.6, 18),
      new THREE.MeshBasicMaterial({
        color: 0x6ff6ff,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flame.name = "flame";
    flame.rotation.x = Math.PI;
    flame.position.y = -0.78;
    group.add(flame);

    return group;
  }
}
