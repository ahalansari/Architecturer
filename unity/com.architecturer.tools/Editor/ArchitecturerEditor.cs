using UnityEditor;
using UnityEngine;

namespace Architecturer.Editor
{
    /// <summary>
    /// Editor integration: when an Architecturer model is dragged into a scene its colliders and
    /// static flags are set up automatically. Also available from Tools > Architecturer.
    /// </summary>
    [InitializeOnLoad]
    public static class ArchitecturerEditor
    {
        const string AutoKey = "Architecturer.AutoSetup";

        static ArchitecturerEditor()
        {
            ObjectChangeEvents.changesPublished += OnChanges;
        }

        public static bool AutoSetup
        {
            get => EditorPrefs.GetBool(AutoKey, true);
            set => EditorPrefs.SetBool(AutoKey, value);
        }

        static void OnChanges(ref ObjectChangeEventStream stream)
        {
            if (!AutoSetup) return;
            for (int i = 0; i < stream.length; i++)
            {
                if (stream.GetEventType(i) != ObjectChangeKind.CreateGameObjectHierarchy) continue;
                stream.GetCreateGameObjectHierarchyEvent(i, out var e);
                var go = EditorUtility.InstanceIDToObject(e.instanceId) as GameObject;
                if (go != null && go.transform.parent == null && ArchitecturerSetup.IsArchitecturerModel(go))
                {
                    var r = Apply(go);
                    Debug.Log($"Architecturer: set up '{go.name}': {r}", go);
                }
            }
        }

        /// <summary>Colliders + static flags, with undo support.</summary>
        public static ArchitecturerSetup.Result Apply(GameObject root)
        {
            Undo.RegisterFullObjectHierarchyUndo(root, "Set up Architecturer model");
            var result = ArchitecturerSetup.SetupColliders(root);
            const StaticEditorFlags flags =
                StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccluderStatic |
                StaticEditorFlags.OccludeeStatic | StaticEditorFlags.ReflectionProbeStatic;
            foreach (var go in ArchitecturerSetup.StaticObjects(root))
            {
                GameObjectUtility.SetStaticEditorFlags(go, GameObjectUtility.GetStaticEditorFlags(go) | flags);
                result.staticObjects++;
            }
            // collider-only objects are static too (they never move)
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                if (t.name.EndsWith(ArchitecturerSetup.MeshColliderSuffix) && !t.name.EndsWith(ArchitecturerSetup.ConvexColliderSuffix))
                    t.gameObject.isStatic = true;
            return result;
        }

        [MenuItem("Tools/Architecturer/Set Up Selected Models")]
        static void SetUpSelected()
        {
            foreach (var go in Selection.gameObjects)
                Debug.Log($"Architecturer: set up '{go.name}': {Apply(go)}", go);
        }

        [MenuItem("Tools/Architecturer/Set Up Selected Models", true)]
        static bool SetUpSelectedValid() => Selection.gameObjects.Length > 0;

        [MenuItem("Tools/Architecturer/Auto Set Up When Placed")]
        static void ToggleAuto() => AutoSetup = !AutoSetup;

        [MenuItem("Tools/Architecturer/Auto Set Up When Placed", true)]
        static bool ToggleAutoValid()
        {
            Menu.SetChecked("Tools/Architecturer/Auto Set Up When Placed", AutoSetup);
            return true;
        }
    }
}
