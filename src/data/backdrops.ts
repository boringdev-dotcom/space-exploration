// AUTO-GENERATED CONFIG (also editable by hand)
// Run `npm run worlds:generate -- --table backdrops` to refresh `splatUrl`.

export interface BackdropPose {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

export interface Backdrop {
  id: string;
  name: string;
  prompt: string;
  splatUrl: string;
  pose: BackdropPose;
}

export const BACKDROPS: Backdrop[] = [
  {
    id: "hangarBay",
    name: "Vehicle Assembly Bay",
    prompt:
      "Photoreal interior of a NASA-style rocket assembly building, vast steel girders, gantry catwalks, " +
      "sodium work lights casting amber pools, distant blue floodlights, polished concrete floor, deep shadows, " +
      "no rockets, no humans, eye-level perspective looking forward into the bay.",
    splatUrl: "",
    pose: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1.0,
    },
  },
];

export function getBackdrop(id: string): Backdrop {
  const backdrop = BACKDROPS.find((b) => b.id === id);
  if (!backdrop) {
    throw new Error(`Unknown backdrop id: ${id}`);
  }
  return backdrop;
}
