using UnityEngine;

namespace Architecturer
{
    /// <summary>
    /// Runtime set-up: add to a model that is spawned at runtime (e.g. loaded with glTFast's GltfAsset) to create its
    /// colliders and, optionally, bake its NavMesh. Models placed in the editor are set up automatically instead.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Architecturer/Architecturer Model")]
    public class ArchitecturerModel : MonoBehaviour
    {
        [Tooltip("Create colliders on Awake (and again when children appear, e.g. after an async glTF load).")]
        public bool setupOnAwake = true;

        [Tooltip("Add NavMesh areas, lift links and door obstacles, and bake the NavMesh once the model is loaded.")]
        public bool navigation = true;

        bool _done, _nav;

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
            if (_done && navigation && !_nav)
            {
                var n = ArchitecturerNav.Setup(gameObject, build: true);
                _nav = n.built;
            }
        }

        public bool IsSetUp => _done;
        public bool HasNavMesh => _nav;
    }
}
