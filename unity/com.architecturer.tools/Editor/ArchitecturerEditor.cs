using System.IO;
using Unity.AI.Navigation;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;

namespace Architecturer.Editor
{
    /// <summary>
    /// Editor integration: when an Architecturer model is dragged into a scene its colliders, static / lightmap flags
    /// and NavMesh are set up automatically. Also available from Tools > Architecturer.
    /// </summary>
    [InitializeOnLoad]
    public static class ArchitecturerEditor
    {
        const string AutoKey = "Architecturer.AutoSetup";
        const string NavKey = "Architecturer.AutoNavMesh";
        const string NavFolder = "Assets/Architecturer/NavMesh";

        static ArchitecturerEditor()
        {
            ObjectChangeEvents.changesPublished += OnChanges;
        }

        public static bool AutoSetup
        {
            get => EditorPrefs.GetBool(AutoKey, true);
            set => EditorPrefs.SetBool(AutoKey, value);
        }

        public static bool AutoNavMesh
        {
            get => EditorPrefs.GetBool(NavKey, true);
            set => EditorPrefs.SetBool(NavKey, value);
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
                    if (AutoNavMesh) Debug.Log($"Architecturer: NavMesh for '{go.name}': {SetUpNavigation(go, bake: true)}", go);
                }
            }
        }

        /// <summary>Colliders + static flags (lightmap static where the export has lightmap UVs), with undo support.</summary>
        public static ArchitecturerSetup.Result Apply(GameObject root)
        {
            Undo.RegisterFullObjectHierarchyUndo(root, "Set up Architecturer model");
            var result = ArchitecturerSetup.SetupColliders(root);
            const StaticEditorFlags flags =
                StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccluderStatic |
                StaticEditorFlags.OccludeeStatic | StaticEditorFlags.ReflectionProbeStatic;
            foreach (var go in ArchitecturerSetup.StaticObjects(root))
            {
                var f = GameObjectUtility.GetStaticEditorFlags(go) | flags;
                // exported with lightmap UVs (uv2): bake lighting into it
                var mf = go.GetComponent<MeshFilter>();
                if (mf != null && mf.sharedMesh != null && mf.sharedMesh.uv2 != null && mf.sharedMesh.uv2.Length > 0)
                {
                    f |= StaticEditorFlags.ContributeGI;
                    var mr = go.GetComponent<MeshRenderer>();
                    if (mr != null) mr.receiveGI = ReceiveGI.Lightmaps;
                    result.lightmapped++;
                }
                GameObjectUtility.SetStaticEditorFlags(go, f);
                result.staticObjects++;
            }
            // collider-only objects are static too (they never move)
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                if (t.name.EndsWith(ArchitecturerSetup.MeshColliderSuffix) && !t.name.EndsWith(ArchitecturerSetup.ConvexColliderSuffix))
                    t.gameObject.isStatic = true;
            return result;
        }

        /// <summary>
        /// NavMesh components (areas, lift links, door obstacles) and, with <paramref name="bake"/>, the bake saved as an
        /// asset under Assets/Architecturer/NavMesh so it survives reloading the scene.
        /// </summary>
        public static ArchitecturerNav.Result SetUpNavigation(GameObject root, bool bake)
        {
            EnsureNavigationSettings();
            Undo.RegisterFullObjectHierarchyUndo(root, "Set up Architecturer NavMesh");
            var r = ArchitecturerNav.Setup(root, build: bake);
            if (bake)
            {
                var surface = root.GetComponent<NavMeshSurface>();
                if (surface != null && surface.navMeshData != null && !AssetDatabase.Contains(surface.navMeshData))
                {
                    Directory.CreateDirectory(NavFolder);
                    var scene = root.scene.IsValid() && !string.IsNullOrEmpty(root.scene.name) ? root.scene.name : "Untitled";
                    var path = AssetDatabase.GenerateUniqueAssetPath($"{NavFolder}/{scene}_{root.name}.asset");
                    AssetDatabase.CreateAsset(surface.navMeshData, path);
                    AssetDatabase.SaveAssets();
                    EditorUtility.SetDirty(surface);
                    if (root.scene.IsValid()) EditorSceneManager.MarkSceneDirty(root.scene);
                }
            }
            return r;
        }

        /// <summary>
        /// Project navigation settings: the five Architecturer areas (named, with their costs) and the "Architecturer
        /// Person" agent (0.25 m radius, 1.8 m tall, 0.2 m steps, 45° slopes). Leaves areas already named otherwise alone.
        /// </summary>
        public static void EnsureNavigationSettings()
        {
            var assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/NavMeshAreas.asset");
            if (assets == null || assets.Length == 0) return;
            var so = new SerializedObject(assets[0]);
            var areas = so.FindProperty("areas");
            if (areas != null && areas.isArray)
                foreach (var a in ArchitecturerNav.Areas.Values)
                {
                    if (a.index >= areas.arraySize) continue;
                    var el = areas.GetArrayElementAtIndex(a.index);
                    var name = el.FindPropertyRelative("name");
                    if (name == null) continue;
                    if (string.IsNullOrEmpty(name.stringValue) || name.stringValue == a.name)
                    {
                        name.stringValue = a.name;
                        var cost = el.FindPropertyRelative("cost");
                        if (cost != null) cost.floatValue = a.cost;
                    }
                    else Debug.LogWarning($"Architecturer: NavMesh area {a.index} is '{name.stringValue}', not '{a.name}': models still use index {a.index}.");
                }
            // the agent type: created once, then sized
            int id = -1;
            for (int i = 0; i < NavMesh.GetSettingsCount(); i++)
            {
                var s = NavMesh.GetSettingsByIndex(i);
                if (NavMesh.GetSettingsNameFromID(s.agentTypeID) == ArchitecturerNav.PersonAgentName) id = s.agentTypeID;
            }
            var settings = so.FindProperty("m_Settings");
            var names = so.FindProperty("m_SettingNames");
            if (id < 0 && settings != null && names != null)
            {
                id = NavMesh.CreateSettings().agentTypeID;
                so.Update();
                settings = so.FindProperty("m_Settings");
                names = so.FindProperty("m_SettingNames");
                for (int i = 0; i < settings.arraySize; i++)
                    if (settings.GetArrayElementAtIndex(i).FindPropertyRelative("agentTypeID").intValue == id)
                    {
                        while (names.arraySize <= i) names.InsertArrayElementAtIndex(names.arraySize);
                        names.GetArrayElementAtIndex(i).stringValue = ArchitecturerNav.PersonAgentName;
                    }
            }
            if (settings != null)
                for (int i = 0; i < settings.arraySize; i++)
                {
                    var el = settings.GetArrayElementAtIndex(i);
                    if (el.FindPropertyRelative("agentTypeID").intValue != id) continue;
                    el.FindPropertyRelative("agentRadius").floatValue = ArchitecturerNav.PersonRadius;
                    el.FindPropertyRelative("agentHeight").floatValue = ArchitecturerNav.PersonHeight;
                    el.FindPropertyRelative("agentClimb").floatValue = ArchitecturerNav.PersonClimb;
                    el.FindPropertyRelative("agentSlope").floatValue = ArchitecturerNav.PersonSlope;
                }
            so.ApplyModifiedPropertiesWithoutUndo();
            AssetDatabase.SaveAssets();
        }

        [MenuItem("Tools/Architecturer/Set Up Selected Models")]
        static void SetUpSelected()
        {
            foreach (var go in Selection.gameObjects)
            {
                Debug.Log($"Architecturer: set up '{go.name}': {Apply(go)}", go);
                if (AutoNavMesh) Debug.Log($"Architecturer: NavMesh for '{go.name}': {SetUpNavigation(go, bake: true)}", go);
            }
        }

        [MenuItem("Tools/Architecturer/Set Up Selected Models", true)]
        static bool SetUpSelectedValid() => Selection.gameObjects.Length > 0;

        [MenuItem("Tools/Architecturer/Bake NavMesh for Selected Models")]
        static void BakeSelected()
        {
            foreach (var go in Selection.gameObjects)
                Debug.Log($"Architecturer: NavMesh for '{go.name}': {SetUpNavigation(go, bake: true)}", go);
        }

        [MenuItem("Tools/Architecturer/Bake NavMesh for Selected Models", true)]
        static bool BakeSelectedValid() => Selection.gameObjects.Length > 0;

        [MenuItem("Tools/Architecturer/Set Up Navigation Settings (areas, agent)")]
        static void SetUpNavSettings()
        {
            EnsureNavigationSettings();
            Debug.Log($"Architecturer: NavMesh areas 27–31 and agent '{ArchitecturerNav.PersonAgentName}' are set up.");
        }

        [MenuItem("Tools/Architecturer/Auto Set Up When Placed")]
        static void ToggleAuto() => AutoSetup = !AutoSetup;

        [MenuItem("Tools/Architecturer/Auto Set Up When Placed", true)]
        static bool ToggleAutoValid()
        {
            Menu.SetChecked("Tools/Architecturer/Auto Set Up When Placed", AutoSetup);
            return true;
        }

        [MenuItem("Tools/Architecturer/Auto Bake NavMesh When Placed")]
        static void ToggleNav() => AutoNavMesh = !AutoNavMesh;

        [MenuItem("Tools/Architecturer/Auto Bake NavMesh When Placed", true)]
        static bool ToggleNavValid()
        {
            Menu.SetChecked("Tools/Architecturer/Auto Bake NavMesh When Placed", AutoNavMesh);
            return true;
        }

        /// <summary>
        /// What the baked NavMesh gives: the agent type, the area of NavMesh per area type, and whether a path runs from the
        /// first hall-like room to every room marker (Unity's own pathfinding).
        /// </summary>
        public static string NavReport(GameObject root)
        {
            var surface = root.GetComponent<NavMeshSurface>();
            if (surface == null) return "no NavMeshSurface";
            var sb = new System.Text.StringBuilder();
            sb.Append($"agent '{NavMesh.GetSettingsNameFromID(surface.agentTypeID)}' r={NavMesh.GetSettingsByID(surface.agentTypeID).agentRadius}; ");
            var tri = NavMesh.CalculateTriangulation();
            var byArea = new System.Collections.Generic.SortedDictionary<int, float>();
            for (int i = 0; i < tri.indices.Length; i += 3)
            {
                var a = tri.vertices[tri.indices[i]]; var b = tri.vertices[tri.indices[i + 1]]; var c = tri.vertices[tri.indices[i + 2]];
                var area = Vector3.Cross(b - a, c - a).magnitude / 2;
                var k = tri.areas[i / 3];
                byArea[k] = (byArea.TryGetValue(k, out var v) ? v : 0) + area;
            }
            foreach (var kv in byArea) sb.Append($"area {kv.Key}: {kv.Value:F0} m²; ");
            var filter = new NavMeshQueryFilter { agentTypeID = surface.agentTypeID, areaMask = NavMesh.AllAreas };
            var rooms = new System.Collections.Generic.List<Transform>();
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                if (t.parent != null && t.parent.name == "rooms") rooms.Add(t);
            Transform start = rooms.Find(r => r.name.Contains("Hall")) ?? (rooms.Count > 0 ? rooms[0] : null);
            if (start == null) return sb.Append("no room markers").ToString();
            if (!NavMesh.SamplePosition(start.position, out var from, 2f, filter)) return sb.Append($"start '{start.name}' is off the NavMesh").ToString();
            var missing = new System.Collections.Generic.List<string>();
            var path = new NavMeshPath();
            int reached = 0;
            foreach (var r in rooms)
            {
                if (NavMesh.SamplePosition(r.position, out var to, 2f, filter) && NavMesh.CalculatePath(from.position, to.position, filter, path) && path.status == NavMeshPathStatus.PathComplete) reached++;
                else missing.Add(r.name);
            }
            sb.Append($"paths from '{start.name}': {reached}/{rooms.Count} rooms");
            if (missing.Count > 0) sb.Append($" (not: {string.Join(", ", missing)})");
            return sb.ToString();
        }

        /// <summary>
        /// Batch mode: import a .glb into the open project, place it, set it up and bake its NavMesh, then report.
        /// <c>Unity -batchmode -projectPath P -executeMethod Architecturer.Editor.ArchitecturerEditor.BatchSetUp -archModel Assets/Models/house.glb -quit</c>
        /// </summary>
        public static void BatchSetUp()
        {
            var args = System.Environment.GetCommandLineArgs();
            string model = null;
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "-archModel") model = args[i + 1];
            if (model == null) throw new System.ArgumentException("-archModel <Assets/...glb> is required");
            AssetDatabase.ImportAsset(model, ImportAssetOptions.ForceUpdate);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(model);
            if (prefab == null) throw new System.Exception($"could not import {model} (is glTFast installed?)");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            Debug.Log($"ARCH-SETUP {Apply(go)}");
            var nav = SetUpNavigation(go, bake: true);
            Debug.Log($"ARCH-NAV {nav}");
            var tri = NavMesh.CalculateTriangulation();
            Debug.Log($"ARCH-NAVMESH vertices={tri.vertices.Length} triangles={tri.indices.Length / 3}");
            Debug.Log($"ARCH-REPORT {NavReport(go)}");
            EditorSceneManager.SaveScene(scene, "Assets/ArchitecturerTest.unity");
        }
    }
}
