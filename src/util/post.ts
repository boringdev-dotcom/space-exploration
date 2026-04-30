import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * Builds an EffectComposer pipeline:
 *   render → bloom → vignette+grain → output (gamma + tone-map)
 *
 * The vignette/grain shader is custom and ultra-cheap.
 */

const VIGNETTE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uVignetteStrength;
  uniform float uGrainStrength;
  varying vec2 vUv;

  // Cheap hash for grain.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;
    vec2 center = vec2(0.5);
    float dist = distance(vUv, center);

    float vignette = smoothstep(0.95, 0.30, dist);
    color *= mix(1.0 - uVignetteStrength, 1.0, vignette);

    float grain = (hash(vUv * 1024.0 + uTime) - 0.5) * uGrainStrength;
    color += grain;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const VIGNETTE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface PostFx {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  bypass: boolean;
  setScene(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number): void;
  setIntensity(level: "default" | "warp" | "calm"): void;
  /**
   * Continuous bias that rides on top of the base intensity preset. Use this
   * to make the picture *breathe* with throttle/boost — e.g. on boost engage,
   * push bias toward 1 and let it ease back to 0 on release.
   *  - bloomMul: multiplies bloom strength (1 = base, 1.5 = punchy).
   *  - grain: replaces the grain strength directly.
   *  - vignette: replaces the vignette strength directly.
   */
  setBias(bias: {
    bloomMul?: number;
    grain?: number;
    vignette?: number;
    /** Multiplier on the configured bloom radius (1 = base). */
    bloomRadiusMul?: number;
  }): void;
  render(deltaSec: number): void;
  dispose(): void;
}

export function createPostFx(renderer: THREE.WebGLRenderer): PostFx {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
  composer.addPass(renderPass);

  // Bloom rendered at half resolution — visually identical, ~4x cheaper.
  const halfW = Math.max(2, Math.round(window.innerWidth * 0.5));
  const halfH = Math.max(2, Math.round(window.innerHeight * 0.5));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(halfW, halfH),
    0.85,
    0.6,
    0.4,
  );
  composer.addPass(bloom);

  const vignette = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uVignetteStrength: { value: 0.5 },
      uGrainStrength: { value: 0.04 },
    },
    vertexShader: VIGNETTE_VERT,
    fragmentShader: VIGNETTE_FRAG,
  });
  composer.addPass(vignette);

  const output = new OutputPass();
  composer.addPass(output);

  let elapsed = 0;
  let baseBloomStrength = 0.85;
  let baseBloomRadius = 0.6;
  let baseGrain = 0.04;
  let baseVignette = 0.5;
  let bloomMul = 1;
  let bloomRadiusMul = 1;

  const applyBase = (level: "default" | "warp" | "calm") => {
    switch (level) {
      case "warp":
        baseBloomStrength = 1.25;
        baseBloomRadius = 0.75;
        baseGrain = 0.055;
        baseVignette = 0.55;
        break;
      case "calm":
        baseBloomStrength = 0.6;
        baseBloomRadius = 0.45;
        baseGrain = 0.03;
        baseVignette = 0.4;
        break;
      case "default":
      default:
        baseBloomStrength = 0.85;
        baseBloomRadius = 0.6;
        baseGrain = 0.04;
        baseVignette = 0.5;
        break;
    }
    bloom.strength = baseBloomStrength * bloomMul;
    bloom.radius = baseBloomRadius * bloomRadiusMul;
    (vignette.uniforms.uGrainStrength as { value: number }).value = baseGrain;
    (vignette.uniforms.uVignetteStrength as { value: number }).value = baseVignette;
  };

  const fx: PostFx = {
    composer,
    bloom,
    bypass: false,

    setScene(scene: THREE.Scene, camera: THREE.Camera) {
      renderPass.scene = scene;
      renderPass.camera = camera;
    },

    setSize(width: number, height: number) {
      composer.setSize(width, height);
      bloom.resolution.set(Math.round(width * 0.5), Math.round(height * 0.5));
    },

    setIntensity(level: "default" | "warp" | "calm") {
      applyBase(level);
    },

    setBias({ bloomMul: bm, grain, vignette: vg, bloomRadiusMul: brm }) {
      if (bm !== undefined) {
        bloomMul = bm;
        bloom.strength = baseBloomStrength * bloomMul;
      }
      if (brm !== undefined) {
        bloomRadiusMul = brm;
        bloom.radius = baseBloomRadius * bloomRadiusMul;
      }
      if (grain !== undefined) {
        (vignette.uniforms.uGrainStrength as { value: number }).value = grain;
      }
      if (vg !== undefined) {
        (vignette.uniforms.uVignetteStrength as { value: number }).value = vg;
      }
    },

    render(deltaSec: number) {
      elapsed += deltaSec;
      (vignette.uniforms.uTime as { value: number }).value = elapsed;
      composer.render(deltaSec);
    },

    dispose() {
      composer.dispose();
    },
  };

  return fx;
}
