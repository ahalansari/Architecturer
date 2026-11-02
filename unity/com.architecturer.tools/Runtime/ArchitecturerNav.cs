using System.Collections.Generic;
using System.Globalization;
using Unity.AI.Navigation;
using UnityEngine;
using UnityEngine.AI;

namespace Architecturer
{
    /// <summary>
    /// NavMesh for an Architecturer model: a NavMeshSurface baked from the model's colliders (walls, floors, stairs as
    /// ramps, furniture boxes), room / stair areas from the "nav-area|..." markers, NavMeshLinks between lift landings
    /// ("nav-lift|..."), door leaves left out of the bake with a carving obstacle at the closed position
    /// (<see cref="ArchitecturerDoor"/>), and small furniture left out so agents walk past it.
    /// </summary>
    public static class ArchitecturerNav
    {
        public const string PersonAgentName = "Architecturer Person";
        public const float PersonRadius = 0.25f, PersonHeight = 1.8f, PersonClimb = 0.2f, PersonSlope = 45f;
        /// <summary>NavMesh voxel size, m.</summary>
        public const float VoxelSize = 0.05f;

        /// <summary>NavMesh areas (the top of Unity's 32, clear of the built-in ones) and their traversal costs.</summary>
        public static readonly Dictionary<string, (int index, string name, float cost)> Areas = new Dictionary<string, (int, string, float)>
        {
            { "indoor", (27, "Indoor", 1f) },
            { "outdoor", (28, "Outdoor", 1.2f) },
            { "wet", (29, "Wet Room", 2f) },
            { "stairs", (30, "Stairs", 1.5f) },
            { "service", (31, "Service", 3f) },
        };

        public const string AreaPrefix = "nav-area|";
        public const string LiftPrefix = "nav-lift|";
        public const string DoorwayPrefix = "nav-doorway|";

        public struct Result
        {
            public int areaVolumes, liftLinks, doors, smallFurnitureIgnored;
            public bool built;
            public override string ToString() =>
                $"{areaVolumes} area volumes, {liftLinks} lift links, {doors} doors, {smallFurnitureIgnored} small items left out of the bake{(built ? ", NavMesh built" : "")}";
        }

        /// <summary>
        /// The agent type to bake for: the "Architecturer Person" agent when the project has it (Tools › Architecturer
        /// › Set Up Navigation Settings creates it), else the first agent type (Humanoid).
        /// </summary>
        public static int PersonAgentTypeID()
        {
            for (int i = 0; i < NavMesh.GetSettingsCount(); i++)
            {
                var s = NavMesh.GetSettingsByIndex(i);
                if (NavMesh.GetSettingsNameFromID(s.agentTypeID) == PersonAgentName) return s.agentTypeID;
            }
            return NavMesh.GetSettingsCount() > 0 ? NavMesh.GetSettingsByIndex(0).agentTypeID : 0;
        }

        /// <summary>Area costs for this session (the editor also stores them in the project's navigation settings).</summary>
        public static void ApplyAreaCosts()
        {
            foreach (var a in Areas.Values) NavMesh.SetAreaCost(a.index, a.cost);
        }

        /// <summary>Add the NavMesh components to a model. Safe to call repeatedly. <paramref name="build"/> bakes in memory.</summary>
        public static Result Setup(GameObject root, bool build, int agentTypeID = -1)
        {
            var result = new Result();
            if (agentTypeID < 0) agentTypeID = PersonAgentTypeID();
            var surface = root.GetComponent<NavMeshSurface>();
            if (surface == null) surface = root.AddComponent<NavMeshSurface>();
            surface.agentTypeID = agentTypeID;
            surface.collectObjects = CollectObjects.Children;
            surface.useGeometry = NavMeshCollectGeometry.PhysicsColliders;
            surface.layerMask = ~0;
            // Unity's default voxel (a third of the radius, ~8 cm) closes 0.8 m doors and tight corners; 5 cm keeps them
            // and matches the server's nav_check
            surface.overrideVoxelSize = true;
            surface.voxelSize = VoxelSize;

            var lifts = new Dictionary<string, SortedDictionary<int, Transform>>();
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                var n = t.name;
                if (n.StartsWith(AreaPrefix)) { if (AddAreaVolume(t)) result.areaVolumes++; }
                else if (n.StartsWith(LiftPrefix))
                {
                    var p = n.Split('|');
                    if (p.Length >= 3 && int.TryParse(p[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var stop))
                    {
                        if (!lifts.TryGetValue(p[1], out var stops)) lifts[p[1]] = stops = new SortedDictionary<int, Transform>();
                        stops[stop] = t;
                    }
                }
                else if (t.parent != null && t.parent.name == "doors")
                {
                    // the leaf's collider would close the doorway in the bake: leave it out, block with an obstacle instead
                    Modifier(t).ignoreFromBuild = true;
                    var door = t.GetComponent<ArchitecturerDoor>();
                    if (door == null) door = t.gameObject.AddComponent<ArchitecturerDoor>();
                    door.Init();
                    result.doors++;
                }
                else if (t.parent != null && t.parent.name == "furniture" && IsSmall(t))
                {
                    Modifier(t).ignoreFromBuild = true;
                    result.smallFurnitureIgnored++;
                }
            }
            foreach (var stops in lifts.Values)
            {
                Transform prev = null;
                foreach (var s in stops.Values)
                {
                    if (prev != null)
                    {
                        var link = prev.GetComponent<NavMeshLink>();
                        if (link == null) link = prev.gameObject.AddComponent<NavMeshLink>();
                        link.agentTypeID = agentTypeID;
                        link.startPoint = Vector3.zero;
                        link.endPoint = prev.InverseTransformPoint(s.position);
                        link.width = 0.9f;
                        link.bidirectional = true;
                        link.costModifier = 5f;
                        result.liftLinks++;
                    }
                    prev = s;
                }
            }
            ApplyAreaCosts();
            if (build)
            {
                surface.BuildNavMesh();
                result.built = true;
            }
            return result;
        }

        static NavMeshModifier Modifier(Transform t)
        {
            var m = t.GetComponent<NavMeshModifier>();
            return m != null ? m : t.gameObject.AddComponent<NavMeshModifier>();
        }

        /// <summary>"nav-area|kind|sizeX|sizeY|height|label": a volume marking the room's floor as that area.</summary>
        static bool AddAreaVolume(Transform t)
        {
            var p = t.name.Split('|');
            if (p.Length < 5 || !Areas.TryGetValue(p[1], out var area)) return false;
            if (!float.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var sx) ||
                !float.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var sy) ||
                !float.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out var h)) return false;
            var v = t.GetComponent<NavMeshModifierVolume>();
            if (v == null) v = t.gameObject.AddComponent<NavMeshModifierVolume>();
            // plan x / y are local x / z (the export keeps markers unrotated); a little below the floor to catch it
            v.size = new Vector3(sx, h + 0.3f, sy);
            v.center = new Vector3(0, h / 2 - 0.15f, 0);
            v.area = area.index;
            return true;
        }

        /// <summary>Lamps, vases, stools: under 0.2 m² or lower than 0.3 m — agents step round or over them.</summary>
        static bool IsSmall(Transform t)
        {
            var b = ColliderBounds(t);
            return b.size.x * b.size.z < 0.2f || b.size.y < 0.3f;
        }

        /// <summary>World bounds of an item's colliders (or renderers when it has none).</summary>
        public static Bounds ColliderBounds(Transform t)
        {
            var any = false;
            var b = new Bounds(t.position, Vector3.zero);
            foreach (var f in t.GetComponentsInChildren<MeshFilter>(true))
            {
                if (f.sharedMesh == null || !f.name.EndsWith(ArchitecturerSetup.ConvexColliderSuffix)) continue;
                var wb = TransformBounds(f.transform, f.sharedMesh.bounds);
                if (!any) { b = wb; any = true; } else b.Encapsulate(wb);
            }
            if (!any)
                foreach (var r in t.GetComponentsInChildren<Renderer>(true))
                {
                    if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
                }
            return b;
        }

        static Bounds TransformBounds(Transform t, Bounds local)
        {
            var c = local.center; var e = local.extents;
            var w = new Bounds(t.TransformPoint(c), Vector3.zero);
            for (int i = 0; i < 8; i++)
                w.Encapsulate(t.TransformPoint(c + new Vector3((i & 1) == 0 ? -e.x : e.x, (i & 2) == 0 ? -e.y : e.y, (i & 4) == 0 ? -e.z : e.z)));
            return w;
        }
    }
}
