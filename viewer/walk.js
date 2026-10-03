// First-person walk mode: mouse look, WASD, gravity, stairs, wall sliding, doors, floor switching.
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const EYE = 1.65; // eye height above the feet
const RADIUS = 0.28; // body radius
const STEP = 0.36; // highest ledge you can step onto (stair risers ~0.18 m)
const WALK = 2.6, RUN = 6.0, FLY = 12;
const GRAVITY = 22, JUMP = 5.2;
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);

/** Walls, floors, furniture and glass baked into one double-sided BVH mesh (doors stay separate: they move). */
function buildCollider(model) {
  const positions = [];
  const indices = [];
  const doors = [];
  const v = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) {
      if (/-(conv)?colonly$/.test(p.name)) return;
      if (p.userData?.kind === "door_leaf") {
        doors.push(o);
        return;
      }
    }
    const g = o.geometry;
    const pos = g.attributes.position;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  geom.computeBoundsTree();
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  for (const d of doors) d.geometry.computeBoundsTree?.();
  return { mesh, doors };
}

export class WalkMode {
  constructor({ camera, renderer, dom, getModel, getLevels, getElevators, onExit, hud }) {
    Object.assign(this, { camera, renderer, dom, getModel, getLevels, getElevators, onExit, hud });
    this.controls = new PointerLockControls(camera, dom);
    this.active = false;
    this.keys = new Set();
    this.vy = 0;
    this.fly = false;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    this.doorState = new Map(); // leaf node -> { open, t, base: {pos, rot}, sign }
    this.hudTimer = 0;

    this.onKeyDown = (e) => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (e.code === "KeyE") this.toggleNearestDoor();
      if (e.code === "KeyF") this.fly = !this.fly;
      if (e.code === "BracketRight" || e.code === "PageUp") this.changeLevel(1);
      if (e.code === "BracketLeft" || e.code === "PageDown") this.changeLevel(-1);
      if (e.code === "KeyX") this.exit();
      if (e.code === "Space" && !this.fly && this.grounded) this.vy = JUMP;
      if (["Space", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.code)) e.preventDefault();
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onClick = () => this.active && !this.controls.isLocked && this.lock();
    // drag to look: works everywhere, including browsers/embeds that refuse pointer lock
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    let dragging = false;
    this.onPointerDown = (e) => {
      if (this.active && !this.controls.isLocked) (dragging = true), this.dom.setPointerCapture?.(e.pointerId);
    };
    this.onPointerUp = () => (dragging = false);
    this.onPointerMove = (e) => {
      if (!this.active || this.controls.isLocked || !dragging) return;
      euler.setFromQuaternion(this.camera.quaternion);
      euler.y -= e.movementX * 0.004;
      euler.x = Math.max(-1.5, Math.min(1.5, euler.x - e.movementY * 0.004));
      this.camera.quaternion.setFromEuler(euler);
    };
    this.controls.addEventListener("lock", () => this.hud.setLocked(true));
    this.controls.addEventListener("unlock", () => this.hud.setLocked(false));
  }

  /** Enter at a world point (feet position), looking toward `lookAt` if given. */
  enter(feet, lookAt) {
    const model = this.getModel();
    if (!model) return;
    this.world = buildCollider(model);
    this.active = true;
    this.keys.clear();
    this.vy = 0;
    this.fly = false;
    this.camera.position.set(feet.x, feet.y + EYE, feet.z);
    if (lookAt) this.camera.lookAt(lookAt.x, feet.y + EYE, lookAt.z);
    this.settle();
    this.spawnY = this.feet;
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
    this.dom.addEventListener("click", this.onClick);
    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    addEventListener("pointerup", this.onPointerUp);
    this.hud.show(true);
    this.lock();
  }

  /** Capture the mouse if the browser allows it; otherwise drag-to-look stays active. */
  lock() {
    try {
      const r = this.dom.requestPointerLock?.();
      r?.catch?.(() => this.hud.noLock?.());
      if (!r) this.controls.lock();
    } catch {
      this.hud.noLock?.();
    }
  }

  /** The model was reloaded (file saved while walking): rebuild collision, keep our position. */
  rebuild() {
    if (!this.active) return;
    this.world = buildCollider(this.getModel());
    this.doorState.clear();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("click", this.onClick);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    removeEventListener("pointerup", this.onPointerUp);
    if (this.controls.isLocked) this.controls.unlock();
    this.hud.show(false);
    this.onExit?.();
  }

  // ---------- queries ----------
  cast(origin, dir, far, includeDoors = true) {
    this.ray.set(origin, dir);
    this.ray.far = far;
    const hits = this.ray.intersectObject(this.world.mesh, false);
    let best = hits[0] ?? null;
    if (includeDoors && this.world.doors.length) {
      for (const h of this.ray.intersectObjects(this.world.doors, false)) {
        if (!best || h.distance < best.distance) best = h;
        break;
      }
    }
    return best;
  }

  /** Height of the floor under (x, z), searching down from `fromY`. */
  floorAt(x, z, fromY, far = 50) {
    const h = this.cast(new THREE.Vector3(x, fromY, z), DOWN, far);
    return h ? h.point.y : null;
  }

  get feet() {
    return this.camera.position.y - EYE;
  }

  /** Drop onto whatever floor is below (used after teleports). */
  settle() {
    const p = this.camera.position;
    const y = this.floorAt(p.x, p.z, this.feet + 1.0, 200);
    if (y !== null) p.y = y + EYE;
    this.grounded = y !== null;
  }

  /** Is there room for a body here (no wall within RADIUS at knee/chest height)? */
  clearAt(x, y, z) {
    for (let a = 0; a < 8; a++) {
      const d = new THREE.Vector3(Math.cos((a / 8) * Math.PI * 2), 0, Math.sin((a / 8) * Math.PI * 2));
      for (const hgt of [0.6, 1.4]) if (this.cast(new THREE.Vector3(x, y + hgt, z), d, RADIUS + 0.1, false)) return false;
    }
    return !this.cast(new THREE.Vector3(x, y + 0.6, z), UP, EYE - 0.4, false);
  }

  // ---------- movement ----------
  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    this.animateDoors(dt);
    const k = this.keys;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    if (!this.fly) fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const wish = new THREE.Vector3();
    if (k.has("KeyW") || k.has("ArrowUp")) wish.add(fwd);
    if (k.has("KeyS") || k.has("ArrowDown")) wish.sub(fwd);
    if (k.has("KeyD")) wish.add(right);
    if (k.has("KeyA")) wish.sub(right);
    // arrow keys turn when the mouse isn't captured
    if (k.has("ArrowLeft")) this.camera.rotateOnWorldAxis(UP, 1.8 * dt);
    if (k.has("ArrowRight")) this.camera.rotateOnWorldAxis(UP, -1.8 * dt);
    const speed = this.fly ? FLY : k.has("ShiftLeft") || k.has("ShiftRight") ? RUN : WALK;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * dt);

    const p = this.camera.position;
    if (this.fly) {
      if (k.has("Space")) wish.y += speed * dt;
      if (k.has("KeyC")) wish.y -= speed * dt;
      p.add(wish);
      this.updateHud(dt);
      return;
    }

    // horizontal: move up to whatever is hit (knee / waist / head height), then slide along it
    let m = new THREE.Vector3(wish.x, 0, wish.z);
    for (let iter = 0; iter < 3 && m.lengthSq() > 1e-10; iter++) {
      const len = m.length();
      const dir = m.clone().divideScalar(len);
      let hit = null;
      for (const hgt of [STEP + 0.05, 1.0, EYE - 0.05]) {
        const h = this.cast(new THREE.Vector3(p.x, this.feet + hgt, p.z), dir, len + RADIUS);
        if (h && (!hit || h.distance < hit.distance)) hit = h;
      }
      if (!hit) {
        p.add(m);
        break;
      }
      // walking into a closed room door opens it (cabinet doors and drawers only open with E)
      const leaf = this.leafOf(hit.object);
      if (leaf && leaf.userData.opening && !this.doorState.get(leaf)?.open) this.toggleDoor(leaf);
      const step = Math.min(Math.max(0, hit.distance - RADIUS), len);
      p.addScaledVector(dir, step);
      const rest = m.clone().multiplyScalar(1 - step / len);
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dir.clone().negate();
      n.y = 0;
      if (n.lengthSq() < 1e-6) break;
      n.normalize();
      if (n.dot(dir) > 0) n.negate();
      m = rest.addScaledVector(n, -rest.dot(n)); // keep only the part along the surface
    }
    // keep a body's width from everything around (no clipping into corners)
    for (let a = 0; a < 8; a++) {
      const d = new THREE.Vector3(Math.cos((a / 8) * Math.PI * 2), 0, Math.sin((a / 8) * Math.PI * 2));
      const h = this.cast(new THREE.Vector3(p.x, this.feet + 1.0, p.z), d, RADIUS);
      if (h) p.addScaledVector(d, -(RADIUS - h.distance));
    }

    // vertical: gravity, step up onto stairs, land on floors
    const floor = this.floorAt(p.x, p.z, this.feet + STEP + 0.05, 200);
    this.vy -= GRAVITY * dt;
    let feet = this.feet + this.vy * dt;
    if (this.vy > 0) {
      const head = this.cast(new THREE.Vector3(p.x, this.feet + EYE - 0.1, p.z), UP, this.vy * dt + 0.2);
      if (head) {
        this.vy = 0;
        feet = this.feet;
      }
    }
    if (floor !== null && feet <= floor + 0.001) {
      // smooth step-up, instant step-down when walking off small ledges
      feet = floor > this.feet ? Math.min(floor, this.feet + 6 * dt + 0.02) : floor;
      if (feet >= floor - 1e-3) this.vy = Math.max(0, this.vy);
      this.grounded = true;
    } else this.grounded = false;
    if (floor === null && feet < -50) {
      // fell off the world: back to where we entered
      this.vy = 0;
      feet = this.spawnY ?? 0;
    }
    p.y = feet + EYE;
    this.updateHud(dt);
  }

  // ---------- doors ----------
  leafOf(o) {
    for (let p = o; p; p = p.parent) if (p.userData?.kind === "door_leaf") return p;
    return null;
  }

  toggleNearestDoor() {
    const me = this.camera.position;
    // prefer whatever door/drawer is under the crosshair
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const aimed = this.cast(me.clone(), fwd, 3);
    const aimedLeaf = aimed && this.leafOf(aimed.object);
    if (aimedLeaf) return this.toggleDoor(aimedLeaf);
    let best = null, bestD = 2.5;
    for (const mesh of this.world.doors) {
      const leaf = this.leafOf(mesh);
      const c = new THREE.Box3().setFromObject(leaf).getCenter(new THREE.Vector3());
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (d < bestD) (best = leaf), (bestD = d);
    }
    if (best) this.toggleDoor(best);
  }

  toggleDoor(leaf) {
    let s = this.doorState.get(leaf);
    if (!s) {
      // swing away from the player: compare the leaf's direction (hinge -> centre) with the player's side
      const hinge = leaf.getWorldPosition(new THREE.Vector3());
      const c = new THREE.Box3().setFromObject(leaf).getCenter(new THREE.Vector3());
      const d = new THREE.Vector3(c.x - hinge.x, 0, c.z - hinge.z);
      const toMe = new THREE.Vector3(this.camera.position.x - hinge.x, 0, this.camera.position.z - hinge.z);
      // rotating by +θ about +Y moves the leaf tip along (d.z, 0, -d.x); pick the sign that moves it away from us
      const away = d.z * toMe.x - d.x * toMe.z < 0;
      s = {
        open: false,
        t: 0,
        base: { pos: leaf.position.clone(), rot: leaf.quaternion.clone() },
        sign: away ? 1 : -1,
        slideDir: d.clone().normalize(),
        slideDistance: null,
        motion: leaf.userData.motion ?? "hinged",
        size: new THREE.Box3().setFromObject(leaf).getSize(new THREE.Vector3()),
      };
      // cabinet doors say exactly how they hinge: a unit axis in plan coords; positive rotation opens
      const hx = leaf.userData.axis;
      if (Array.isArray(hx) && hx.length === 3 && s.motion === "hinged") {
        const world = new THREE.Vector3(hx[0], hx[2], -hx[1]);
        const parentQ = leaf.parent ? leaf.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
        s.hingeAxis = world.applyQuaternion(parentQ).normalize();
        s.maxAngle = ((leaf.userData.maxAngle ?? 95) * Math.PI) / 180;
      }
      // drawers / sliding fronts can say exactly how they move (plan coords: x east, y north, z up)
      const ax = leaf.userData.slideAxis;
      if (Array.isArray(ax) && ax.length === 3) {
        const world = new THREE.Vector3(ax[0], ax[2], -ax[1]);
        // the axis is given in plan space; bring it into the leaf's parent frame
        const parentQ = leaf.parent ? leaf.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
        s.slideDir = world.applyQuaternion(parentQ).normalize();
        s.slideDistance = leaf.userData.slideDistance ?? null;
      }
      this.doorState.set(leaf, s);
    }
    s.open = !s.open;
  }

  animateDoors(dt) {
    for (const [leaf, s] of this.doorState) {
      const target = s.open ? 1 : 0;
      if (s.t === target) continue;
      s.t = target > s.t ? Math.min(1, s.t + dt * 1.8) : Math.max(0, s.t - dt * 1.8);
      const e = s.t * s.t * (3 - 2 * s.t);
      leaf.position.copy(s.base.pos);
      leaf.quaternion.copy(s.base.rot);
      // sliding panels run along their own length (hinge side -> far edge); garage doors lift
      if (s.motion === "slide") leaf.position.addScaledVector(s.slideDir, (s.slideDistance ?? Math.max(s.size.x, s.size.z) * 0.9) * e);
      else if (s.motion === "lift") leaf.position.y += s.size.y * 0.92 * e;
      else if (s.hingeAxis) leaf.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(s.hingeAxis, s.maxAngle * e));
      else leaf.rotateY(s.sign * (Math.PI / 2) * e);
      leaf.updateMatrixWorld(true);
    }
  }

  // ---------- floors ----------
  changeLevel(delta) {
    const levels = this.getLevels();
    if (!levels.length) return;
    const feet = this.feet;
    let cur = 0;
    levels.forEach((l, i) => feet >= l.elevation - 0.5 && (cur = i));
    const next = Math.max(0, Math.min(levels.length - 1, cur + delta));
    if (next === cur) return;
    const spot = this.findSpot(levels[next]);
    if (!spot) return this.hud.flash(`No walkable floor found on ${levels[next].name}`);
    this.camera.position.set(spot.x, spot.y + EYE, spot.z);
    this.vy = 0;
    this.hud.flash(levels[next].name);
  }

  /** A standable spot on a level: its lift stop, else near our current position, else near a room centre. */
  findSpot(level) {
    const ok = (x, z) => {
      const y = this.floorAt(x, z, level.elevation + 2.2, 4);
      if (y === null || y < level.elevation - 0.3 || y > level.elevation + 0.7) return null;
      return this.clearAt(x, y, z) ? new THREE.Vector3(x, y, z) : null;
    };
    const tries = [];
    for (const e of this.getElevators()) for (const s of e.stops) if (s.level === level.id) tries.push([s.at[0], -s.at[1]]);
    tries.push([this.camera.position.x, this.camera.position.z]);
    const model = this.getModel();
    model.traverse((o) => {
      if (o.userData?.kind !== "room" && o.userData?.kind !== "terrace") return;
      let lv = o.parent;
      while (lv && lv.userData?.kind !== "level") lv = lv.parent;
      if (lv?.userData?.id !== level.id) return;
      const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      tries.push([c.x, c.z]);
    });
    for (const [x, z] of tries)
      for (let r = 0; r <= 8; r += 0.75)
        for (let a = 0; a < (r === 0 ? 1 : 12); a++) {
          const s = ok(x + Math.cos((a / 12) * Math.PI * 2) * r, z + Math.sin((a / 12) * Math.PI * 2) * r);
          if (s) return s;
        }
    return null;
  }

  // ---------- HUD ----------
  updateHud(dt) {
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.25;
    const p = this.camera.position;
    const h = this.cast(new THREE.Vector3(p.x, this.feet + 0.5, p.z), DOWN, 2, false);
    let room = "", level = "";
    if (h) {
      // find the room whose floor we're over (rooms are separate nodes in the viewer export)
      const model = this.getModel();
      const probe = new THREE.Raycaster(new THREE.Vector3(p.x, this.feet + 0.5, p.z), DOWN, 0, 1.0);
      const rooms = [];
      model.traverse((o) => (o.userData?.kind === "room" || o.userData?.kind === "terrace") && rooms.push(o));
      const hit = probe.intersectObjects(rooms, true)[0];
      if (hit) {
        for (let o = hit.object; o; o = o.parent) {
          if (!room && o.userData?.room) room = o.userData.room;
          if (o.userData?.kind === "level") {
            level = this.getLevels().find((l) => l.id === o.userData.id)?.name ?? o.name;
            break;
          }
        }
      }
    }
    if (!level) {
      const levels = this.getLevels();
      let cur = null;
      for (const l of levels) if (this.feet >= l.elevation - 0.5) cur = l;
      level = cur?.name ?? "";
    }
    this.hud.status(room || (this.fly ? "flying" : "outside"), level, this.fly);
  }
}
