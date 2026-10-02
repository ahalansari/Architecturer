using UnityEngine;

namespace Architecturer
{
    /// <summary>
    /// Runtime fallback: add to a model that is spawned at runtime (e.g. loaded with glTFast's GltfAsset)
    /// to create its colliders. Models placed in the editor are set up automatically instead.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Architecturer/Architecturer Model")]
    public class ArchitecturerModel : MonoBehaviour
    {
        [Tooltip("Create colliders on Awake (and again when children appear, e.g. after an async glTF load).")]
        public bool setupOnAwake = true;

        bool _done;

        void Awake()
        {
            if (setupOnAwake) Setup();
        }

        void OnTransformChildrenChanged()
        {
            if (setupOnAwake) Setup();
        }

        public void Setup()
        {
            var r = ArchitecturerSetup.SetupColliders(gameObject);
            if (r.meshColliders + r.convexColliders > 0) _done = true;
        }

        public bool IsSetUp => _done;
    }
}
