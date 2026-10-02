using System.Collections.Generic;
using UnityEngine;

namespace Architecturer
{
    /// <summary>
    /// Turns the collision nodes in an Architecturer model into Unity colliders.
    /// Naming convention (shared with Godot's importer):
    ///   "*-colonly"     static mesh collider (walls, floors, stair ramps, roofs)
    ///   "*-convcolonly" convex box collider on movable items (furniture, door leaves)
    /// Their render meshes are hidden; the colliders keep using the mesh.
    /// </summary>
    public static class ArchitecturerSetup
    {
        public const string MeshColliderSuffix = "-colonly";
        public const string ConvexColliderSuffix = "-convcolonly";

        public struct Result
        {
            public int meshColliders;
            public int convexColliders;
            public int staticObjects;
            public override string ToString() =>
                $"{meshColliders} mesh colliders, {convexColliders} box colliders, {staticObjects} static objects";
        }

        public static bool IsColliderNode(Transform t) =>
            t.name.EndsWith(MeshColliderSuffix) || t.name.EndsWith(ConvexColliderSuffix);

        /// <summary>True for objects exported by Architecturer (they carry collider or merged static nodes).</summary>
        public static bool IsArchitecturerModel(GameObject go)
        {
            foreach (var t in go.GetComponentsInChildren<Transform>(true))
                if (IsColliderNode(t) || t.name.EndsWith("_static")) return true;
            return false;
        }

        /// <summary>
        /// Furniture and door leaves can move; everything else in the model is static architecture.
        /// </summary>
        public static bool IsMovable(Transform t, Transform root)
        {
            for (var p = t; p != null && p != root; p = p.parent)
            {
                var n = p.name;
                if (n == "furniture" || n == "doors") return true;
                if (n.EndsWith("_leaf") || n.EndsWith("_leaf_left") || n.EndsWith("_leaf_right") ||
                    n.EndsWith("_panel") || n.EndsWith("_panel_fixed") || n.EndsWith("_panel_slide")) return true;
            }
            return false;
        }

        /// <summary>Add colliders and hide collider meshes. Safe to call repeatedly.</summary>
        public static Result SetupColliders(GameObject root)
        {
            var result = new Result();
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                bool convex = t.name.EndsWith(ConvexColliderSuffix);
                if (!convex && !t.name.EndsWith(MeshColliderSuffix)) continue;
                var filter = t.GetComponent<MeshFilter>();
                if (filter == null || filter.sharedMesh == null) continue;

                var collider = t.GetComponent<MeshCollider>();
                if (collider == null) collider = t.gameObject.AddComponent<MeshCollider>();
                collider.sharedMesh = filter.sharedMesh;
                collider.convex = convex;

                var renderer = t.GetComponent<MeshRenderer>();
                if (renderer != null) renderer.enabled = false;
                if (convex) result.convexColliders++;
                else result.meshColliders++;
            }
            return result;
        }

        /// <summary>Visible static architecture (for static batching / occlusion), excluding movable items and colliders.</summary>
        public static List<GameObject> StaticObjects(GameObject root)
        {
            var list = new List<GameObject>();
            foreach (var r in root.GetComponentsInChildren<MeshRenderer>(true))
            {
                var t = r.transform;
                if (IsColliderNode(t) || IsMovable(t, root.transform)) continue;
                list.Add(r.gameObject);
            }
            return list;
        }
    }
}
