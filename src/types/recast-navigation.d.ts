// recast-navigation ships declarations with extensionless re-exports ("export * from './detour'"), which NodeNext
// resolution cannot follow; these are the parts the navigation check uses.
declare module "@recast-navigation/core" {
  export interface Vector3 {
    x: number;
    y: number;
    z: number;
  }
  export function init(): Promise<void>;
  export class NavMesh {
    destroy(): void;
  }
  export class NavMeshQuery {
    constructor(navMesh: NavMesh);
    findClosestPoint(position: Vector3, options?: { halfExtents?: Vector3 }): { success: boolean; status: number; polyRef: number; point: Vector3; isPointOverPoly: boolean };
    computePath(
      start: Vector3,
      end: Vector3,
      options?: { halfExtents?: Vector3; maxPathPolys?: number; maxStraightPathPoints?: number },
    ): { success: boolean; error?: { name: string; status?: number }; path: Vector3[] };
    destroy(): void;
  }
  export function getNavMeshPositionsAndIndices(navMesh: NavMesh, flags?: number): [positions: number[], indices: number[]];
}

declare module "@recast-navigation/generators" {
  import type { NavMesh, Vector3 } from "@recast-navigation/core";
  export interface OffMeshConnectionParams {
    startPosition: Vector3;
    endPosition: Vector3;
    radius: number;
    bidirectional: boolean;
    area?: number;
    flags?: number;
    userId?: number;
  }
  export interface SoloNavMeshGeneratorConfig {
    cs: number;
    ch: number;
    walkableSlopeAngle: number;
    walkableHeight: number;
    walkableClimb: number;
    walkableRadius: number;
    maxEdgeLen: number;
    maxSimplificationError: number;
    minRegionArea: number;
    mergeRegionArea: number;
    maxVertsPerPoly: number;
    detailSampleDist: number;
    detailSampleMaxError: number;
    borderSize: number;
    offMeshConnections: OffMeshConnectionParams[];
  }
  export function generateSoloNavMesh(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    config?: Partial<SoloNavMeshGeneratorConfig>,
  ): { success: true; navMesh: NavMesh } | { success: false; navMesh: undefined; error: string };
}
