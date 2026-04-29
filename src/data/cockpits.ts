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
    splatUrl: "https://cdn.marble.worldlabs.ai/d632e6ce-15b6-4f76-ac38-c3e363296aa3/5c242270-aee9-400a-b083-0f7b0b822505_ceramic.spz",
    // Marble's scan origin sits at (0, 0, 0) looking down -Z (the windshield
    // direction), which is exactly where our cockpit camera lives. The
    // splat is parented to the camera so it follows the player's head.
    pose: {
      cameraOffset: [0, 0, 0],
      splatRotation: [0, 0, 0],
      splatScale: 1.0,
    },
  },
];

export function getCockpit(id: string): Cockpit {
  const cockpit = COCKPITS.find((c) => c.id === id);
  if (!cockpit) {
    throw new Error(`Unknown cockpit id: ${id}`);
  }
  return cockpit;
}
