import { z } from "zod";

/** Shared schema building blocks (imported by schema.ts and by element modules that define their own schemas). */

export const Point = z.tuple([z.number(), z.number()]).describe("2D plan point [x, y] in meters (x = east, y = north)");
export const Polygon = z.array(Point).min(3).describe("Closed polygon as a list of [x, y] points (do not repeat the first point)");
export const Mat = z
  .string()
  .describe('Material name from the library (see list_materials), a custom material from `materials`, or a hex color like "#c0a080"');
export const Id = z.string().regex(/^[A-Za-z0-9_\-.]+$/, "ids may only contain letters, digits, _ - .");
export const Direction = z
  .union([z.number(), z.enum(["north", "south", "east", "west"])])
  .describe("Degrees counter-clockwise from east (0=east, 90=north, 180=west, 270=south) or a compass word");
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]).describe("[x, y, z] in meters; z relative to the level elevation");
