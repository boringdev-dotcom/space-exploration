// AUTO-GENERATED CONFIG (also editable by hand)
// Run `npm run worlds:generate` (or `npm run worlds:mock`) to refresh the
// `splatUrl` for each destination. The rest of the metadata is curated.

export interface PlanetTheme {
  /** lit side colour for the destination orb. */
  light: string;
  /** mid-tone for the destination orb. */
  mid: string;
  /** terminator / shadow side. */
  dark: string;
  /** glow halo. */
  glow: string;
}

export interface Planet {
  id: string;
  name: string;
  /** subtitle shown on the destination card and HUD. */
  tagline: string;
  /** scanner readout shown in the surface HUD. */
  flavor: string;
  /** distance in millions of km — drives travel time. */
  distanceMkm: number;
  /** approximate surface gravity (Earth g = 1). */
  gravityG: number;
  /** atmosphere description for the arrival panel. */
  atmosphere: string;
  /** surface temperature label. */
  surfaceTemp: string;
  /** Marble API prompt used by the generator script. */
  prompt: string;
  /** SPZ URL for the surface splat. */
  splatUrl: string;
  /** Optional browser-served GLB shown in cinematic scenes. */
  modelUrl?: string;
  /** Optional initial surface look target in camera-local world coordinates. */
  surfaceLookAt?: [number, number, number];
  /** colours for the destination orb + flight skybox accent. */
  theme: PlanetTheme;
}

export const PLANETS: Planet[] = [
  {
    id: "luna",
    name: "Luna",
    tagline: "Earth's Moon · Sea of Tranquility",
    flavor:
      "Regolith stretches to a crisp horizon. Earth hangs low in a black sky, a blue marble the size of a fist.",
    distanceMkm: 0.384,
    gravityG: 0.166,
    atmosphere: "Vacuum",
    surfaceTemp: "-173 / +127 °C",
    prompt:
      "Photorealistic surface of the Moon, gray regolith craters and rolling lunar plains, Earth visible in a pitch-black starry sky, harsh sunlight casting long shadows, NASA Apollo aesthetic, ground-level perspective, no humans, no rovers.",
    splatUrl: "https://cdn.marble.worldlabs.ai/87f86884-8f9f-4136-94af-e2c95c88a25d/511a5e3a-6c26-4370-a92b-3d9f3cda8498_ceramic.spz",
    modelUrl: "/models/moon/moon.glb",
    surfaceLookAt: [-0.45, -0.25, -1],
    theme: {
      light: "#f1f1f0",
      mid: "#9a9a9a",
      dark: "#2a2a2c",
      glow: "rgba(220, 232, 255, 0.45)",
    },
  },
  {
    id: "mars",
    name: "Mars",
    tagline: "Red Planet · Tharsis Plateau",
    flavor:
      "Iron-oxide dust covers wind-carved rock. Olympus Mons ghosts the western horizon under a salmon-pink sky.",
    distanceMkm: 78,
    gravityG: 0.38,
    atmosphere: "CO₂ · 0.6%",
    surfaceTemp: "-63 °C avg",
    prompt:
      "Photorealistic surface of Mars, red ochre dust plains with scattered basalt boulders, distant volcano silhouette, dusty pink-orange sky, low afternoon sun, ground-level perspective, no humans, no rovers, no signage.",
    splatUrl: "https://cdn.marble.worldlabs.ai/1fee1320-b9ea-465f-86b0-9a6ab78f2273/7e4e27d4-5b37-4d5a-a76c-7e07f7bfae40_ceramic.spz",
    modelUrl: "/models/mars/mars_the_red_planet_free.glb",
    theme: {
      light: "#ffb287",
      mid: "#c8552d",
      dark: "#3a1108",
      glow: "rgba(255, 124, 70, 0.5)",
    },
  },
  {
    id: "europa",
    name: "Europa",
    tagline: "Jovian Moon · Conamara Chaos",
    flavor:
      "A frozen lattice of cracked ice runs to every horizon. Jupiter dominates the sky, banded and immense.",
    distanceMkm: 628,
    gravityG: 0.134,
    atmosphere: "Trace O₂",
    surfaceTemp: "-160 °C",
    prompt:
      "Photorealistic surface of Europa, fractured pale-blue ice sheets with reddish hydrate veins, smooth icy plains, Jupiter looming massive in a dark starry sky, soft cold sunlight, ground-level perspective, no humans.",
    splatUrl: "https://cdn.marble.worldlabs.ai/21fcffa3-411e-4f0f-8a2a-abe9533326ed/4f161ce6-3f2a-43c0-b033-92ce61508fd3_ceramic.spz",
    modelUrl: "/models/europa/europa.glb",
    theme: {
      light: "#dff5ff",
      mid: "#7aa6c2",
      dark: "#0e2237",
      glow: "rgba(170, 220, 255, 0.55)",
    },
  },
  {
    id: "titan",
    name: "Titan",
    tagline: "Saturnian Moon · Kraken Mare shore",
    flavor:
      "Methane mist drifts over dunes of frozen hydrocarbons. Saturn glows behind a thick orange haze.",
    distanceMkm: 1430,
    gravityG: 0.14,
    atmosphere: "N₂ · CH₄",
    surfaceTemp: "-179 °C",
    prompt:
      "Photorealistic surface of Titan, dunes of dark hydrocarbon sand, methane mist near the horizon, thick orange-amber sky, distant ringed Saturn faintly visible through haze, dim diffuse sunlight, ground-level perspective, no humans.",
    splatUrl: "https://cdn.marble.worldlabs.ai/0c3cb742-6d14-4ddd-9ef2-7e07117f48b0/57584c9b-8723-48bc-a5b3-d1f242f9eb0a_ceramic.spz",
    modelUrl: "/models/titan/titan.glb",
    theme: {
      light: "#ffe2a8",
      mid: "#c79248",
      dark: "#412300",
      glow: "rgba(255, 196, 110, 0.55)",
    },
  },
];

export function getPlanet(id: string): Planet {
  const planet = PLANETS.find((p) => p.id === id);
  if (!planet) {
    throw new Error(`Unknown planet id: ${id}`);
  }
  return planet;
}
