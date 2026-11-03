import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  loadCourse,
  loadHeights,
  loadIndex,
  type Course,
  type CourseIndexEntry,
  type Hole,
  type Tee,
  type XY,
} from "./course";
import { buildHoleScene, type HoleScene } from "./hole";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $("view");
const status = $("status");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
view.appendChild(labelRenderer.domElement);

const HORIZON = new THREE.Color("#dce9f2");
const scene = new THREE.Scene();
scene.background = HORIZON;
// Clear over the hole itself; the surrounding ground melts into the horizon.
scene.fog = new THREE.Fog(HORIZON, 700, 2600);
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4500, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { zenith: { value: new THREE.Color("#7fb2e0") }, horizon: { value: HORIZON } },
    vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader:
      "uniform vec3 zenith; uniform vec3 horizon; varying vec3 vDir; void main() { float t = pow(clamp(vDir.y, 0.0, 1.0), 0.6); gl_FragColor = vec4(mix(horizon, zenith, t), 1.0); }",
  }),
);
scene.add(sky);
scene.add(new THREE.HemisphereLight("#cfe3f5", "#4a5a35", 1.15));
const sun = new THREE.DirectionalLight("#fff4e0", 2.0);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 9000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
controls.screenSpacePanning = false;

const resolution = new THREE.Vector2();
type Mode = "tee" | "top" | "green";

interface State {
  courses: CourseIndexEntry[];
  course: Course | null;
  hole: Hole | null;
  scene: HoleScene | null;
  teeSet: string;
  exag: number;
  mode: Mode;
  animation: ((now: number) => boolean) | null;
}
const state: State = { courses: [], course: null, hole: null, scene: null, teeSet: "", exag: 1.5, mode: "tee", animation: null };
let loadToken = 0;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w, h);
  state.scene?.setResolution(w, h);
}
window.addEventListener("resize", resize);
resize();

function teeFor(hole: Hole, setKey = state.teeSet): Tee {
  const set = state.course?.tee_sets.find((s) => s.key === setKey);
  const id = set?.tees[String(hole.number)];
  return hole.tees.find((t) => t.id === id) ?? hole.tees.reduce((a, b) => (b.length_yd > a.length_yd ? b : a));
}

const playsLike = (tee: Tee) => Math.round(tee.middle_yd + tee.elev_change_ft / 3);

function renderChrome() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const tee = teeFor(hole);
  $("hole-num").textContent = `Hole ${hole.number}`;
  $("hole-par").textContent = hole.par ? ` · Par ${hole.par}` : "";
  $("hole-hcp").textContent = hole.handicap ? `Hcp ${hole.handicap}` : "";
  $("tee-chip").textContent = course.tee_sets.find((s) => s.key === state.teeSet)?.label ?? "Tee";
  const plays = Math.abs(tee.elev_change_ft) >= 3 ? `<div class="plays">Plays ${playsLike(tee)}</div>` : "";
  $("card").innerHTML = `
    <div class="eyebrow">Centre</div>
    <div class="big">${Math.round(tee.middle_yd)}</div>
    <div class="fb">F ${Math.round(tee.front_yd)} · B ${Math.round(tee.back_yd)}</div>
    ${plays}`;
  document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => b.classList.toggle("active", b.dataset.cam === state.mode));
}

let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 900);
}

// --- cameras -------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

function pathLength(path: XY[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  return total;
}

/** Point at distance s (metres) along a polyline, extended straight past either end. */
function along(path: XY[], s: number): XY {
  let rest = s;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (rest <= len || i === path.length - 2) {
      const t = rest / len;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    rest -= len;
  }
  return path[0];
}

interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

function axisOf(from: XY, to: XY): THREE.Vector3 {
  return new THREE.Vector3(to[0] - from[0], 0, -(to[1] - from[1])).normalize();
}

/**
 * Tee view: the smallest pull-back behind the tee that frames the tee near the bottom of the
 * screen and the back of the green near the top, aiming so the two sit symmetrically.
 */
function teePose(hs: HoleScene, hole: Hole, tee: Tee): Pose {
  const L = pathLength(tee.path);
  const d = axisOf(tee.point, hole.green.middle);
  const teeP = hs.ground(tee.point);
  const backP = hs.ground(hole.green.back);
  const lineP = tee.path.map((p) => hs.ground(p));
  const probe = camera.clone();
  const project = (p: THREE.Vector3) => p.clone().project(probe);
  const aim = (pos: THREE.Vector3, f: number) => {
    const target = hs.ground(along(tee.path, L * f));
    probe.position.copy(pos);
    probe.lookAt(target);
    probe.updateMatrixWorld();
    return target;
  };
  const place = (k: number) => {
    const pos = teeP.clone().addScaledVector(d, -(0.2 * L + 25) * k).addScaledVector(UP, (0.25 * L + 15) * k);
    let lo = 0.2;
    let hi = 1.2;
    for (let i = 0; i < 12; i++) {
      const f = (lo + hi) / 2;
      aim(pos, f);
      // Aiming further down the hole moves both points down the screen.
      if (project(teeP).y + project(backP).y > -0.08) lo = f;
      else hi = f;
    }
    return { pos, target: aim(pos, (lo + hi) / 2) };
  };
  const fits = () =>
    project(teeP).y >= -0.64 && project(backP).y <= 0.56 && lineP.every((p) => Math.abs(project(p).x) < 0.82);
  let lo = 0.3;
  let hi = 4;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    place(mid);
    if (fits()) hi = mid;
    else lo = mid;
  }
  return place(hi);
}

function topPose(hs: HoleScene, hole: Hole, tee: Tee): Pose {
  const d = axisOf(tee.point, hole.green.middle);
  const side = new THREE.Vector3().crossVectors(d, UP);
  const pts = [...tee.path, hole.green.back].map((p) => hs.ground(p));
  const origin = pts[0];
  const a = pts.map((p) => p.clone().sub(origin).dot(d));
  const s = pts.map((p) => p.clone().sub(origin).dot(side));
  const [a0, a1, s0, s1] = [Math.min(...a), Math.max(...a), Math.min(...s), Math.max(...s)];
  const center = origin.clone().addScaledVector(d, (a0 + a1) / 2).addScaledVector(side, (s0 + s1) / 2);
  center.y = hs.ground([center.x, -center.z]).y;
  const vt = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const h = Math.max((a1 - a0 + 40) / 0.8 / (2 * vt), (s1 - s0 + 70) / (2 * vt * camera.aspect));
  return { pos: center.clone().addScaledVector(UP, h).addScaledVector(d, -h * 0.02), target: center };
}

function greenPose(hs: HoleScene, hole: Hole, tee: Tee): Pose {
  const L = pathLength(tee.path);
  const from = along(tee.path, Math.max(0, L - 60));
  const d = axisOf(from, hole.green.middle);
  const target = hs.ground(hole.green.middle);
  // Fit the green plus a few metres of surround to 85% of the screen width.
  const size = Math.max(hole.green.depth_yd, hole.green.width_yd) * 0.9144 + 36;
  const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const dist = Math.max(40, size / 0.85 / 2 / Math.tan(halfH));
  const pitch = THREE.MathUtils.degToRad(35);
  return {
    pos: target.clone().addScaledVector(d, -dist * Math.cos(pitch)).addScaledVector(UP, dist * Math.sin(pitch)),
    target,
  };
}

function poseFor(mode: Mode): Pose | null {
  const { hole, scene: hs } = state;
  if (!hole || !hs) return null;
  const tee = teeFor(hole);
  return mode === "top" ? topPose(hs, hole, tee) : mode === "green" ? greenPose(hs, hole, tee) : teePose(hs, hole, tee);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function goTo(pose: Pose, ms: number) {
  if (ms <= 0) {
    state.animation = null;
    camera.position.copy(pose.pos);
    controls.target.copy(pose.target);
    controls.update();
    return;
  }
  const p0 = camera.position.clone();
  const t0 = controls.target.clone();
  const start = performance.now();
  controls.enabled = false;
  state.animation = (now) => {
    const t = Math.min((now - start) / ms, 1);
    const e = ease(t);
    camera.position.lerpVectors(p0, pose.pos, e);
    controls.target.lerpVectors(t0, pose.target, e);
    camera.lookAt(controls.target);
    if (t < 1) return true;
    controls.enabled = true;
    controls.update();
    return false;
  };
}

function setMode(mode: Mode, ms = 600) {
  state.mode = mode;
  const pose = poseFor(mode);
  if (pose) goTo(pose, ms);
  renderChrome();
}

function flyTheHole() {
  const { hole, scene: hs } = state;
  if (!hole || !hs) return;
  const tee = teeFor(hole);
  const path = tee.path;
  const total = pathLength(path);
  const duration = THREE.MathUtils.clamp(total * 14, 5000, 8000);
  const startPose = teePose(hs, hole, tee);
  const endPose = greenPose(hs, hole, tee);
  const start = performance.now();
  controls.enabled = false;
  state.animation = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const e = ease(t);
    const s = e * total;
    const flying = hs.ground(along(path, s - 70), 45);
    const pos = t < 0.15 ? startPose.pos.clone().lerp(flying, ease(t / 0.15)) : t > 0.85 ? flying.lerp(endPose.pos, ease((t - 0.85) / 0.15)) : flying;
    const ahead = hs.ground(along(path, Math.min(s + 60, total)));
    const target = t > 0.85 ? ahead.lerp(endPose.target, ease((t - 0.85) / 0.15)) : ahead;
    camera.position.copy(pos);
    controls.target.copy(target);
    camera.lookAt(target);
    if (t < 1) return true;
    state.mode = "green";
    renderChrome();
    controls.enabled = true;
    return false;
  };
  document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => b.classList.toggle("active", b.dataset.cam === "fly"));
}

document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) =>
  b.addEventListener("click", () => {
    const cam = b.dataset.cam!;
    if (cam === "fly") flyTheHole();
    else setMode(cam as Mode);
  }),
);

// --- swipe between holes -------------------------------------------------

let swipe: { x: number; y: number; t: number; id: number } | null = null;
let pointers = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointers++;
  swipe = pointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
});
const endPointer = (e: PointerEvent) => {
  pointers = Math.max(0, pointers - 1);
  if (!swipe || swipe.id !== e.pointerId) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  const fast = performance.now() - swipe.t < 300;
  swipe = null;
  if (fast && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * Math.tan(Math.PI / 6)) step(dx < 0 ? 1 : -1);
};
renderer.domElement.addEventListener("pointerup", endPointer);
renderer.domElement.addEventListener("pointercancel", endPointer);

// --- sheets --------------------------------------------------------------

const backdrop = $("sheet-backdrop");
function openSheet(html: string, bind?: (body: HTMLElement) => void) {
  const body = $("sheet-body");
  body.innerHTML = html;
  bind?.(body);
  backdrop.hidden = false;
}
const closeSheet = () => (backdrop.hidden = true);
backdrop.addEventListener("click", (e) => e.target === backdrop && closeSheet());
window.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

function courseSheet() {
  const rows = state.courses
    .map(
      (c) =>
        `<button class="row${c.slug === state.course?.slug ? " selected" : ""}" data-slug="${c.slug}"><span>${c.name}<br><span class="muted">${c.city ?? ""}</span></span></button>`,
    )
    .join("");
  openSheet(`<h3>Courses</h3>${rows}`, (body) =>
    body.querySelectorAll<HTMLButtonElement>("[data-slug]").forEach((b) =>
      b.addEventListener("click", () => {
        closeSheet();
        if (b.dataset.slug !== state.course?.slug) showCourse(b.dataset.slug!);
      }),
    ),
  );
}

function teeSheet() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const rows = course.tee_sets
    .map((s) => {
      const t = teeFor(hole, s.key);
      return `<button class="row${s.key === state.teeSet ? " selected" : ""}" data-key="${s.key}"><span>${s.label}</span><span><b>${Math.round(t.length_yd)}</b> <span class="muted">· ${Math.round(s.total_yd)} total</span></span></button>`;
    })
    .join("");
  openSheet(`<h3>Tees</h3><p class="sub">Hole ${hole.number} yardage</p>${rows}`, (body) =>
    body.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((b) =>
      b.addEventListener("click", () => {
        closeSheet();
        state.teeSet = b.dataset.key!;
        if (state.hole && state.scene) state.scene.setTee(teeFor(state.hole));
        setMode(state.mode);
      }),
    ),
  );
}

function infoSheet() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const tee = teeFor(hole);
  const tees = course.tee_sets
    .map((s) => `<div class="row"><span>${s.label}</span><b>${Math.round(teeFor(hole, s.key).length_yd)} yd</b></div>`)
    .join("");
  const hazards = tee.hazards.length
    ? tee.hazards
        .map(
          (h) =>
            `<div class="row"><span>${h.greenside ? "Greenside " : ""}${h.kind}, ${h.side}</span><span><b>${Math.round(h.reach_yd)}</b> <span class="muted">reach</span> · <b>${Math.round(h.carry_yd)}</b> <span class="muted">carry</span></span></div>`,
        )
        .join("")
    : `<p class="muted">No bunkers or water near the line of play.</p>`;
  const g = hole.green;
  const el = course.sources.elevation;
  const exag = [1, 1.5, 2, 3]
    .map((v) => `<button data-exag="${v}" class="${v === state.exag ? "active" : ""}">${v}×</button>`)
    .join("");
  openSheet(
    `<h3>Hole ${hole.number}${hole.par ? ` · Par ${hole.par}` : ""}</h3>
    <p class="sub">${course.name}</p>
    <h4>Tees</h4>${tees}
    <h4>Green</h4>
    <div class="row"><span>Front / centre / back</span><b>${Math.round(tee.front_yd)} / ${Math.round(tee.middle_yd)} / ${Math.round(tee.back_yd)}</b></div>
    <div class="row"><span>Depth × width</span><b>${Math.round(g.depth_yd)} × ${Math.round(g.width_yd)} yd</b></div>
    <div class="row"><span>Tee to green</span><b>${tee.elev_change_ft > 0 ? "+" : ""}${tee.elev_change_ft.toFixed(1)} ft</b></div>
    <div class="row"><span>Plays like</span><b>${playsLike(tee)} yd</b></div>
    <h4>Hazards from ${course.tee_sets.find((s) => s.key === state.teeSet)?.label ?? "this tee"}</h4>${hazards}
    <h4>Terrain height</h4><div class="segmented">${exag}</div>
    <h4>Data</h4>
    <p class="muted">Green data confidence: ${g.confidence} · lidar ${g.lidar_year ?? "year unknown"}<br>
    Elevation: ${el.name} (${el.quality}), ${el.credit}<br>
    Map data ${course.sources.osm.credit}, ODbL · OSM data ${course.sources.osm.timestamp.slice(0, 10)}</p>`,
    (body) =>
      body.querySelectorAll<HTMLButtonElement>("[data-exag]").forEach((b) =>
        b.addEventListener("click", () => {
          state.exag = Number(b.dataset.exag);
          body.querySelectorAll("[data-exag]").forEach((x) => x.classList.toggle("active", x === b));
          state.scene?.setExaggeration(state.exag);
          setMode(state.mode, 300);
        }),
      ),
  );
}

function creditsSheet() {
  const el = state.course?.sources.elevation;
  openSheet(`<h3>Credits</h3>
    <p class="muted">Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).<br><br>
    Elevation: ${el ? `${el.name}, ${el.credit}` : "Illinois State Geological Survey county lidar and the U.S. Geological Survey 3D Elevation Program"}.<br><br>
    Trees are placed from OpenStreetMap tree points and wooded areas; their heights are illustrative.</p>`);
}

$("menu").addEventListener("click", courseSheet);
$("tee-chip").addEventListener("click", teeSheet);
$("card").addEventListener("click", infoSheet);
$("credits").addEventListener("click", creditsSheet);

// --- loading -------------------------------------------------------------

async function showHole(number: number, announce = false) {
  const course = state.course;
  if (!course) return;
  const hole = course.holes.find((h) => h.number === number) ?? course.holes[0];
  const token = ++loadToken;
  const slow = window.setTimeout(() => (status.textContent = `Loading hole ${hole.number}…`), 250);
  const grid = await loadHeights(course.slug, hole.terrain);
  clearTimeout(slow);
  status.textContent = "";
  if (token !== loadToken) return;
  if (state.scene) {
    scene.remove(state.scene.group);
    state.scene.dispose();
  }
  state.hole = hole;
  state.scene = buildHoleScene(course, hole, grid, resolution, teeFor(hole), state.exag);
  sun.position.copy(state.scene.sunDirection).multiplyScalar(1000);
  scene.add(state.scene.group);
  history.replaceState(null, "", `#${course.slug}/${hole.number}`);
  state.mode = "tee";
  renderChrome();
  goTo(teePose(state.scene, hole, teeFor(hole)), 0);
  if (announce) toast(`Hole ${hole.number}${hole.par ? ` · Par ${hole.par}` : ""}`);
}

async function showCourse(slug: string, holeNumber = 1) {
  status.textContent = "Loading course…";
  const course = await loadCourse(slug);
  state.course = course;
  state.teeSet = course.tee_sets[0]?.key ?? "";
  await showHole(holeNumber);
}

const step = (delta: number) => state.hole && showHole(((state.hole.number - 1 + delta + 18) % 18) + 1, true);
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
window.addEventListener("keydown", (e) => {
  if (!backdrop.hidden) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

// --- label decluttering --------------------------------------------------

const tmp = new THREE.Vector3();
function declutter() {
  const labels = state.scene?.labels;
  if (!labels) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const sorted = [...labels].sort((a, b) => a.priority - b.priority);
  for (const { object } of sorted) {
    object.getWorldPosition(tmp);
    const dist = Math.hypot(tmp.x - controls.target.x, tmp.z - controls.target.z);
    tmp.project(camera);
    let opacity = THREE.MathUtils.clamp((450 - dist) / 200, 0, 1);
    const el = object.element;
    const bw = el.offsetWidth || 30;
    const bh = el.offsetHeight || 16;
    const x = (tmp.x * 0.5 + 0.5) * w;
    const y = (-tmp.y * 0.5 + 0.5) * h;
    const r = { x0: x - bw / 2 - 2, y0: y - bh / 2 - 2, x1: x + bw / 2 + 2, y1: y + bh / 2 + 2 };
    if (tmp.z > 1 || taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0)) opacity = 0;
    if (opacity > 0.05) taken.push(r);
    const value = opacity.toFixed(2);
    if (el.style.opacity !== value) el.style.opacity = value;
  }
}

function frame(now: number) {
  if (state.animation && !state.animation(now)) state.animation = null;
  if (!state.animation) controls.update();
  sky.position.copy(camera.position);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  declutter();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(async () => {
  try {
    const { courses } = await loadIndex();
    if (!courses.length) throw new Error("no course packages; run npm run courses");
    state.courses = courses;
    const [slug, hole] = decodeURIComponent(location.hash.slice(1)).split("/");
    const known = courses.some((c) => c.slug === slug);
    await showCourse(known ? slug : courses[0].slug, known ? Number(hole) || 1 : 1);
  } catch (err) {
    status.textContent = `Couldn't load courses: ${(err as Error).message}`;
    console.error(err);
  }
})();
