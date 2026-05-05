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
  uniform float uChromatic;
  uniform float uRadialBlur;
  uniform float uWarmth;
  uniform float uLensDirt;
  varying vec2 vUv;

  // Cheap hash for grain.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 center = vec2(0.5);
    vec2 fromCenter = vUv - center;
    float dist = length(fromCenter);

    vec2 radialOffset = fromCenter * uRadialBlur * 0.024;
    vec2 chromaOffset = fromCenter * uChromatic * smoothstep(0.1, 0.85, dist) * 0.010;

    vec3 base = texture2D(tDiffuse, vUv).rgb;
    vec3 streakA = texture2D(tDiffuse, clamp(vUv - radialOffset, 0.001, 0.999)).rgb;
    vec3 streakB = texture2D(tDiffuse, clamp(vUv - radialOffset * 2.1, 0.001, 0.999)).rgb;
    vec3 color = mix(base, (base + streakA + streakB) / 3.0, clamp(uRadialBlur, 0.0, 1.0));

    if (uChromatic > 0.0001) {
      color.r = texture2D(tDiffuse, clamp(vUv + chromaOffset, 0.001, 0.999)).r;
      color.b = texture2D(tDiffuse, clamp(vUv - chromaOffset, 0.001, 0.999)).b;
    }

    float vignette = smoothstep(0.95, 0.30, dist);
    color *= mix(1.0 - uVignetteStrength, 1.0, vignette);

    float grain = (hash(vUv * 1024.0 + uTime) - 0.5) * uGrainStrength;
    color += grain;

    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float dirt = hash(floor(vUv * vec2(42.0, 24.0)) + floor(uTime * 0.15));
    dirt = smoothstep(0.62, 1.0, dirt) * smoothstep(0.35, 1.0, luma);
    color += dirt * uLensDirt * vec3(1.0, 0.82, 0.58);

    color = mix(color, color * vec3(1.08, 1.01, 0.93), uWarmth);

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
   *  - chromatic/radialBlur/warmth/lensDirt: flight-optics polish dials.
   */
  setBias(bias: {
    bloomMul?: number;
    grain?: number;
    vignette?: number;
    /** Multiplier on the configured bloom radius (1 = base). */
    bloomRadiusMul?: number;
    chromatic?: number;
    radialBlur?: number;
    warmth?: number;
    lensDirt?: number;
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
  // Strength dialed down ~80% (and threshold bumped) so the rocket reads
  // clearly instead of being washed out by glow during cruise / boost.
  const halfW = Math.max(2, Math.round(window.innerWidth * 0.5));
  const halfH = Math.max(2, Math.round(window.innerHeight * 0.5));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(halfW, halfH),
    0.20,  // strength (was 0.85)
    0.58,  // radius
    0.74,  // threshold (was 0.4) — only strongly-lit pixels bloom
  );
  composer.addPass(bloom);

  const vignette = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uVignetteStrength: { value: 0.5 },
      uGrainStrength: { value: 0.04 },
      uChromatic: { value: 0 },
      uRadialBlur: { value: 0 },
      uWarmth: { value: 0 },
      uLensDirt: { value: 0 },
    },
    vertexShader: VIGNETTE_VERT,
    fragmentShader: VIGNETTE_FRAG,
  });
  composer.addPass(vignette);

  const output = new OutputPass();
  composer.addPass(output);

  let elapsed = 0;
  // Base values dimmed ~80% from the original cinematic levels so the
  // rocket reads as a solid object instead of a smear of light.
  let baseBloomStrength = 0.20;
  let baseBloomRadius = 0.58;
  let baseGrain = 0.03;
  let baseVignette = 0.42;
  let bloomMul = 1;
  let bloomRadiusMul = 1;

  const applyBase = (level: "default" | "warp" | "calm") => {
    switch (level) {
      case "warp":
        baseBloomStrength = 0.28;
        baseBloomRadius = 0.68;
        baseGrain = 0.035;
        baseVignette = 0.44;
        break;
      case "calm":
        baseBloomStrength = 0.14;
        baseBloomRadius = 0.48;
        baseGrain = 0.026;
        baseVignette = 0.36;
        break;
      case "default":
      default:
        baseBloomStrength = 0.20;
        baseBloomRadius = 0.58;
        baseGrain = 0.03;
        baseVignette = 0.42;
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

    setBias({
      bloomMul: bm,
      grain,
      vignette: vg,
      bloomRadiusMul: brm,
      chromatic,
      radialBlur,
      warmth,
      lensDirt,
    }) {
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
      if (chromatic !== undefined) {
        (vignette.uniforms.uChromatic as { value: number }).value = chromatic;
      }
      if (radialBlur !== undefined) {
        (vignette.uniforms.uRadialBlur as { value: number }).value = radialBlur;
      }
      if (warmth !== undefined) {
        (vignette.uniforms.uWarmth as { value: number }).value = warmth;
      }
      if (lensDirt !== undefined) {
        (vignette.uniforms.uLensDirt as { value: number }).value = lensDirt;
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
