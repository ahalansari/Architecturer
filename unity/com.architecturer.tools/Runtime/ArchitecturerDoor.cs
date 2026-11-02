using UnityEngine;
using UnityEngine.AI;

namespace Architecturer
{
    /// <summary>
    /// A door leaf exported by Architecturer (pivot at the hinge). Open, agents walk through; closed, a carving
    /// NavMeshObstacle fills the doorway. The obstacle sits on the "nav-doorway|…" marker, which the export turns back
    /// to the closed position, so it covers the doorway even when the leaf is modelled ajar.
    /// <code>door.SetOpen(false); // blocks the NavMesh at the doorway</code>
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Architecturer/Architecturer Door")]
    public class ArchitecturerDoor : MonoBehaviour
    {
        [Tooltip("Open doors let agents through; closed ones carve the NavMesh.")]
        public bool open = true;

        [Tooltip("Also swing the leaf: degrees from closed when open (0 keeps the leaf as modelled).")]
        public float swingAngle;

        NavMeshObstacle _obstacle;
        Quaternion _closed, _modelled;
        bool _init;

        void Awake() => Init();

        /// <summary>Find (or create) the doorway obstacle. Safe to call repeatedly.</summary>
        public void Init()
        {
            if (_init && _obstacle != null) return;
            Transform doorway = null;
            foreach (Transform c in transform)
                if (c.name.StartsWith(ArchitecturerNav.DoorwayPrefix)) doorway = c;
            if (doorway == null)
            {
                doorway = new GameObject(ArchitecturerNav.DoorwayPrefix + "0").transform;
                doorway.SetParent(transform, false);
            }
            _modelled = transform.localRotation;
            _closed = _modelled * doorway.localRotation;
            // the leaf's own geometry, measured in the doorway marker's (closed) frame: the marker only turns about the hinge
            var bounds = new Bounds();
            var any = false;
            foreach (var f in GetComponentsInChildren<MeshFilter>(true))
            {
                if (f.sharedMesh == null || f.name.EndsWith(ArchitecturerSetup.ConvexColliderSuffix) || f.transform != transform && f.transform.parent != transform) continue;
                var b = f.sharedMesh.bounds;
                if (!any) { bounds = b; any = true; } else bounds.Encapsulate(b);
            }
            if (!any) bounds = new Bounds(new Vector3(0.45f, 1.05f, 0), new Vector3(0.9f, 2.1f, 0.05f));
            _obstacle = doorway.GetComponent<NavMeshObstacle>();
            if (_obstacle == null) _obstacle = doorway.gameObject.AddComponent<NavMeshObstacle>();
            _obstacle.shape = NavMeshObstacleShape.Box;
            _obstacle.center = bounds.center;
            // at least wall-thick, so the carve closes the gap
            _obstacle.size = new Vector3(bounds.size.x, bounds.size.y, Mathf.Max(bounds.size.z, 0.25f));
            _obstacle.carving = true;
            _obstacle.carveOnlyStationary = false;
            _init = true;
            Apply();
        }

        public void SetOpen(bool value)
        {
            open = value;
            Apply();
        }

        public void Toggle() => SetOpen(!open);

        void OnValidate()
        {
            if (_init) Apply();
        }

        void Apply()
        {
            if (_obstacle != null) _obstacle.enabled = !open;
            if (swingAngle != 0)
                transform.localRotation = open ? _closed * Quaternion.Euler(0, swingAngle, 0) : _closed;
            else if (_init)
                transform.localRotation = open ? _modelled : _closed;
            // keep the obstacle in the doorway whatever the leaf does
            if (_obstacle != null) _obstacle.transform.rotation = transform.parent != null ? transform.parent.rotation * _closed : _closed;
        }
    }
}
