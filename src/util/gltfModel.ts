import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
loader.register((parser) => new PbrSpecularGlossinessCompat(parser));

const KHR_PBR_SPECULAR_GLOSSINESS = "KHR_materials_pbrSpecularGlossiness";

export async function loadNormalizedGltfModel(
  url: string,
  targetDiameter: number,
): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(url);
  const wrapper = new THREE.Group();
  wrapper.add(gltf.scene);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  if (Number.isFinite(maxDim) && maxDim > 0) {
    gltf.scene.position.sub(center);
    gltf.scene.scale.setScalar(targetDiameter / maxDim);
  }

  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.frustumCulled = false;
    }
  });

  return wrapper;
}

export function disposeObjectTree(root: THREE.Object3D | null): void {
  if (!root) return;

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      geometries.add(mesh.geometry);
    }

    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach((mat) => collectMaterial(mat, materials, textures));
    } else if (material) {
      collectMaterial(material, materials, textures);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function collectMaterial(
  material: THREE.Material,
  materials: Set<THREE.Material>,
  textures: Set<THREE.Texture>,
): void {
  materials.add(material);

  Object.values(material).forEach((value) => {
    if (value instanceof THREE.Texture) {
      textures.add(value);
    }
  });
}

interface GltfTextureInfo {
  index: number;
}

interface SpecularGlossinessExtension {
  diffuseFactor?: [number, number, number, number];
  diffuseTexture?: GltfTextureInfo;
  glossinessFactor?: number;
}

interface GltfMaterialDef {
  extensions?: Record<string, unknown>;
}

interface GltfParser {
  json: {
    materials?: GltfMaterialDef[];
  };
  assignTexture(
    materialParams: Record<string, unknown>,
    mapName: string,
    mapDef: GltfTextureInfo,
    colorSpace?: string,
  ): Promise<unknown>;
}

class PbrSpecularGlossinessCompat {
  readonly name = KHR_PBR_SPECULAR_GLOSSINESS;

  constructor(private readonly parser: GltfParser) {}

  extendMaterialParams(
    materialIndex: number,
    materialParams: Record<string, unknown>,
  ): Promise<unknown[]> | null {
    const materialDef = this.parser.json.materials?.[materialIndex];
    const extension = materialDef?.extensions?.[this.name] as
      | SpecularGlossinessExtension
      | undefined;

    if (!extension) return null;

    materialParams.metalness = 0;
    materialParams.roughness = 1 - (extension.glossinessFactor ?? 0.5);

    if (extension.diffuseFactor) {
      const [r, g, b, a] = extension.diffuseFactor;
      materialParams.color = new THREE.Color(r, g, b);
      materialParams.opacity = a;
    }

    const pending: Array<Promise<unknown>> = [];
    if (extension.diffuseTexture) {
      pending.push(
        this.parser.assignTexture(
          materialParams,
          "map",
          extension.diffuseTexture,
          THREE.SRGBColorSpace,
        ),
      );
    }

    return Promise.all(pending);
  }
}
