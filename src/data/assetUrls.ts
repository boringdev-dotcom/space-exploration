/** Shared public URLs for large assets (single source of truth + preload lists). */
export const ARTEMIS_ROCKET_GLB_URL =
  "/models/rockets/artemis_ii_-_space_launch_system_sls.glb";

export const EARTH_GLB_URL = "/models/earth/earth.glb";

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
