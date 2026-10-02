import type { ProjectInput } from "./schema/schema.js";

/** Minimal valid plan: one room with a door, a window and a roof. */
export const STARTER_PROJECT: ProjectInput = {
  name: "Starter cabin",
  defaults: { exteriorWallThickness: 0.25, exteriorMaterial: "siding_white" },
  levels: [
    {
      id: "ground",
      height: 2.8,
      walls: [{ id: "ext", points: [[0, 0], [6, 0], [6, 4], [0, 4]], closed: true }],
      openings: [
        { id: "front_door", type: "door", at: [1.5, 0] },
        { id: "window_s", type: "window", at: [4, 0], width: 1.4 },
      ],
      rooms: [{ name: "Main room", polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], floorMaterial: "wood_floor_oak" }],
      furniture: [
        { type: "bed", position: [4.6, 2.9], facing: "west", width: 1.4 },
        { type: "table", position: [1.6, 2.6], width: 1.2, depth: 0.8 },
        { type: "chair", position: [1.6, 2.0], facing: "north" },
      ],
      roofs: [{ type: "gable", polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], pitch: 30, material: "shingles_gray" }],
    },
  ],
};
