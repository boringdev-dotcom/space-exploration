// AUTO-GENERATED CONFIG (also editable by hand)
// Run `npm run worlds:generate -- --table cockpits` to refresh `splatUrl`.
// The `pose` calibration is curated and stays put across regenerations.

export interface CockpitPose {
  /** Splat position in cockpit-rig local space (origin = pilot's eye). */
  cameraOffset: [number, number, number];
  /** Splat rotation Euler angles applied AFTER Spark's right-side-up flip. */
  splatRotation: [number, number, number];
  /** Uniform scale to bring the splat to "real cabin" size. */
  splatScale: number;
}

export interface Cockpit {
  id: string;
  name: string;
  /** Marble API prompt. Carefully art-directed to match the brand palette. */
  prompt: string;
  /** SPZ URL produced by Marble. Updated by the generator script. */
  splatUrl: string;
  pose: CockpitPose;
  /**
   * Multiplicative tint applied to every splat in the cockpit. Marble bakes its
   * own "studio" lighting into the splat colours which reads too bright through
   * ACES tone-mapping; this lets us pull the cabin back to a moody dim level
   * without re-prompting. (1, 1, 1) = original brightness.
   */
  tint: [number, number, number];
  /** Global splat opacity multiplier (0..1). Lowers slightly so the windshield reads cleaner. */
  opacity: number;
}

export const COCKPITS: Cockpit[] = [
  {
    id: "artemis",
    name: "Artemis II Crew Cabin",
    prompt:
      "Photoreal first-person interior of an Artemis spacecraft cockpit, NASA aesthetic. " +
      "Two pilot seats foreground left and right, brushed-aluminum and matte-black panels wrapping the lower 270 degrees of view. " +
      "Glowing plasma-cyan (#00f3ff) primary instrument readouts and warning-amber (#ffba20) secondary indicators on multi-function displays. " +
      "Dim cool-white interior lighting plus subtle red emergency under-glow at the footwells. " +
      "Direct forward is a wide curved windshield opening onto pure black empty space — no stars, no planets, no objects in front, just deep void. " +
      "Crisp specular highlights on switch panels, shallow depth of field, hero composition, no humans, no astronauts.",
    // Mocked default — points at a public Spark sample so the rig renders
    // end-to-end before the real Marble world is generated. Will be
    // overwritten by `worlds:generate -- --table cockpits`.
    splatUrl: "https://cdn.marble.worldlabs.ai/524e6c70-2a1f-4b31-a006-e97a283766ab/c97cc273-8483-4826-8805-1740c09bc05e_ceramic.spz",
    // Marble's scan origin sits at (0, 0, 0) looking down -Z (the windshield
    // direction), which is exactly where our cockpit camera lives. The
    // splat is parented to the camera so it follows the player's head.
    pose: {
      cameraOffset: [0, 0, 0],
      splatRotation: [0, 0, 0],
      splatScale: 1.0,
    },
    // Slightly cool 55% tint — dims the over-bright Marble cabin enough to
    // read as an interior without losing the instrument detail.
    tint: [0.55, 0.58, 0.62],
    opacity: 0.95,
  },
];

export function getCockpit(id: string): Cockpit {
  const cockpit = COCKPITS.find((c) => c.id === id);
  if (!cockpit) {
    throw new Error(`Unknown cockpit id: ${id}`);
  }
  return cockpit;
}
