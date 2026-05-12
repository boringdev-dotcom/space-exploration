/** Shared public URLs for large assets (single source of truth + preload lists). */
export const ARTEMIS_ROCKET_GLB_URL =
  "/models/rockets/artemis_ii_-_space_launch_system_sls.glb";

export const EARTH_GLB_URL = "/models/earth/earth.glb";

/**
 * Optional GLB cockpit interior. Drop a CC0/CC-BY spacecraft cockpit GLB here
 * and the rig will load it; otherwise the cockpit falls back to a richly
 * detailed procedural shell built in {@link createProceduralCockpit}.
 */
export const COCKPIT_GLB_URL = "/models/cockpits/spacecraft_cockpit.glb";

/**
 * URL prefix for the Spark public mock splats seeded by `npm run worlds:mock`.
 * These are stock demo splats (e.g. a butterfly) that we never want to show
 * in place of a real world — if a `splatUrl` still points here, the scene
 * should fall back to procedural content rather than rendering the mock.
 */
export const MOCK_SPLAT_PREFIX = "https://sparkjs.dev/";

export function isMockSplatUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  return url.startsWith(MOCK_SPLAT_PREFIX);
}

/**
 * Marble SPZ for the Earth launch pad scene rendered during liftoff. Set
 * this to a Marble-generated `.spz` URL (e.g. one produced by the prompt
 * "Photoreal launch pad at Cape Canaveral, Saturn V class rocket gantry,
 *  fuel tower, ground crew, predawn light") to enable the cinematic
 * ground-level takeoff. Leave empty to keep the existing Earth-GLB-only
 * liftoff. The scene fades out once the ship climbs above
 * {@link LAUNCHPAD_FADE_END_ALT} so the camera can cleanly hand off to
 * the orbital Earth view.
 */
export const LAUNCHPAD_SPZ_URL =
  "https://cdn.marble.worldlabs.ai/f8166d34-1987-460f-b26b-80b7ee40de61/d7d12c4a-8183-43c6-919a-1e7eba90de33_ceramic.spz";
