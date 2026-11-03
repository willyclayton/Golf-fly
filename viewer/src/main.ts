import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { loadCourse, loadHeights, loadIndex, type Course, type Hole, type Tee, type XY } from "./course";
import { buildHoleScene, type HoleScene } from "./hole";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $("view");
const status = $("status");
const courseSelect = $<HTMLSelectElement>("course");
const teeSelect = $<HTMLSelectElement>("teeset");
const exagInput = $<HTMLInputElement>("exag");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.position = "absolute";
labels.domElement.style.inset = "0";
labels.domElement.style.pointerEvents = "none";
view.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#a9c8e3");
scene.fog = new THREE.Fog("#a9c8e3", 900, 2400);
scene.add(new THREE.HemisphereLight("#eef5ff", "#5d6b4a", 1.4));
// Sun from the north-west at 45 degrees, the usual hillshade convention.
const sun = new THREE.DirectionalLight("#ffffff", 2.2);
sun.position.set(-1, 1.4, -1);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.screenSpacePanning = false;

const resolution = new THREE.Vector2();

interface State {
  course: Course | null;
  hole: Hole | null;
  scene: HoleScene | null;
  teeSet: string;
  exag: number;
  flight: ((now: number) => boolean) | null;
}
const state: State = { course: null, hole: null, scene: null, teeSet: "", exag: 2, flight: null };
let loadToken = 0;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  state.scene?.setResolution(w, h);
  resolution.set(w, h);
}
window.addEventListener("resize", resize);
resize();

function teeFor(hole: Hole): Tee {
  const set = state.course?.tee_sets.find((s) => s.key === state.teeSet);
  const id = set?.tees[String(hole.number)];
  return hole.tees.find((t) => t.id === id) ?? hole.tees.reduce((a, b) => (b.length_yd > a.length_yd ? b : a));
}

const fmt = (n: number | null | undefined, digits = 0) => (n == null ? "–" : n.toFixed(digits));
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;

function renderCard() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const tee = teeFor(hole);
  const set = course.tee_sets.find((s) => s.key === state.teeSet);
  const others = course.tee_sets
    .map((s) => {
      const t = hole.tees.find((x) => x.id === s.tees[String(hole.number)]);
      return t ? `${s.label} ${Math.round(t.length_yd)}` : null;
    })
    .filter(Boolean)
    .join(" · ");
  const hazards = tee.hazards
    .map(
      (h) =>
        `<li>${h.greenside ? "Greenside " : ""}${h.kind} ${h.side}: reach ${Math.round(h.reach_yd)}, carry ${Math.round(h.carry_yd)}</li>`,
    )
    .join("");
  const g = hole.green;
  $("card").innerHTML = `
    <h2>Hole ${hole.number} · Par ${fmt(hole.par)} · Hcp ${fmt(hole.handicap)}</h2>
    <div class="yards">${Math.round(tee.length_yd)} <small>yd · ${set?.label ?? "Back"}</small></div>
    <div>${others}</div>
    <dl>
      <dt>Green F / M / B</dt><dd>${Math.round(tee.front_yd)} / ${Math.round(tee.middle_yd)} / ${Math.round(tee.back_yd)}</dd>
      <dt>Green size</dt><dd>${fmt(g.depth_yd)} deep × ${fmt(g.width_yd)} wide (yd)</dd>
      <dt>Tee to green</dt><dd>${signed(tee.elev_change_ft)} ft</dd>
    </dl>
    ${hazards ? `<ul>${hazards}</ul>` : ""}
    <span class="badge ${g.confidence}">Green data: ${g.confidence} · lidar ${g.lidar_year ?? "year unknown"}</span>`;
  $("hole-name").textContent = `Hole ${hole.number}`;
}

// --- cameras -------------------------------------------------------------

function direction(from: XY, to: XY): THREE.Vector3 {
  return new THREE.Vector3(to[0] - from[0], 0, -(to[1] - from[1])).normalize();
}

function cameraPose(kind: string): { pos: THREE.Vector3; target: THREE.Vector3 } | null {
  const { hole, scene: hs } = state;
  if (!hole || !hs) return null;
  const tee = teeFor(hole);
  const mid = hole.green.middle;
  const d = direction(tee.point, mid);
  const up = new THREE.Vector3(0, 1, 0);
  if (kind === "top") {
    const length = Math.hypot(mid[0] - tee.point[0], mid[1] - tee.point[1]);
    const center = hs.ground([(tee.point[0] + mid[0]) / 2, (tee.point[1] + mid[1]) / 2]);
    return { pos: center.clone().addScaledVector(up, length * 1.15 + 60).addScaledVector(d, -1), target: center };
  }
  if (kind === "green") {
    const target = hs.ground(mid);
    return { pos: target.clone().addScaledVector(d, -38).addScaledVector(up, 16), target };
  }
  const ahead: XY = [tee.point[0] + (mid[0] - tee.point[0]) * 0.55, tee.point[1] + (mid[1] - tee.point[1]) * 0.55];
  return { pos: hs.ground(tee.point).addScaledVector(d, -45).addScaledVector(up, 38), target: hs.ground(ahead) };
}

function setCamera(kind: string) {
  const pose = cameraPose(kind);
  if (!pose) return;
  state.flight = null;
  camera.position.copy(pose.pos);
  controls.target.copy(pose.target);
  controls.update();
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

function flyTheHole() {
  const { hole, scene: hs } = state;
  if (!hole || !hs) return;
  const path = teeFor(hole).path;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  const duration = THREE.MathUtils.clamp(total * 14, 5000, 8000);
  const start = performance.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  controls.enabled = false;
  state.flight = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const s = -32 + ease(t) * (total - 38 + 32);
    camera.position.copy(hs.ground(along(path, s), THREE.MathUtils.lerp(38, 20, t)));
    controls.target.copy(hs.ground(along(path, Math.min(s + 70, total))));
    camera.lookAt(controls.target);
    if (t >= 1) {
      controls.enabled = true;
      return false;
    }
    return true;
  };
}

document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) =>
  b.addEventListener("click", () => {
    const kind = b.dataset.cam!;
    if (kind === "fly") flyTheHole();
    else setCamera(kind === "reset" ? "tee" : kind);
  }),
);

// --- loading -------------------------------------------------------------

async function showHole(number: number) {
  const course = state.course;
  if (!course) return;
  const hole = course.holes.find((h) => h.number === number) ?? course.holes[0];
  const token = ++loadToken;
  status.textContent = `Loading hole ${hole.number}…`;
  const grid = await loadHeights(course.slug, hole.terrain);
  if (token !== loadToken) return;
  if (state.scene) {
    scene.remove(state.scene.group);
    state.scene.dispose();
  }
  state.hole = hole;
  state.scene = buildHoleScene(course, hole, grid, resolution, teeFor(hole), state.exag);
  scene.add(state.scene.group);
  status.textContent = "";
  location.hash = `${course.slug}/${hole.number}`;
  renderCard();
  setCamera("tee");
}

async function showCourse(slug: string, holeNumber = 1) {
  status.textContent = "Loading course…";
  const course = await loadCourse(slug);
  state.course = course;
  courseSelect.value = slug;
  teeSelect.innerHTML = course.tee_sets
    .map((s) => `<option value="${s.key}">${s.label} · ${Math.round(s.total_yd)} yd</option>`)
    .join("");
  state.teeSet = course.tee_sets[0]?.key ?? "";
  const el = course.sources.elevation;
  $("credits").textContent =
    `${course.name} · Map data ${course.sources.osm.credit} (ODbL) · Elevation: ${el.name} (${el.quality}), ${el.credit}`;
  await showHole(holeNumber);
}

courseSelect.addEventListener("change", () => showCourse(courseSelect.value));
teeSelect.addEventListener("change", () => {
  state.teeSet = teeSelect.value;
  if (state.hole && state.scene) {
    state.scene.setTee(teeFor(state.hole));
    renderCard();
  }
});
exagInput.addEventListener("input", () => {
  state.exag = Number(exagInput.value);
  $("exag-value").textContent = `${state.exag}x`;
  state.scene?.setExaggeration(state.exag);
});
const step = (delta: number) => state.hole && showHole(((state.hole.number - 1 + delta + 18) % 18) + 1);
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

function frame(now: number) {
  if (state.flight && !state.flight(now)) state.flight = null;
  if (!state.flight) controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(async () => {
  try {
    const { courses } = await loadIndex();
    if (!courses.length) throw new Error("no course packages; run npm run courses");
    courseSelect.innerHTML = courses
      .map((c) => `<option value="${c.slug}">${c.name}${c.city ? ` · ${c.city}` : ""}</option>`)
      .join("");
    const [slug, hole] = decodeURIComponent(location.hash.slice(1)).split("/");
    const known = courses.some((c) => c.slug === slug);
    await showCourse(known ? slug : courses[0].slug, known ? Number(hole) || 1 : 1);
  } catch (err) {
    status.textContent = `Couldn't load courses: ${(err as Error).message}`;
    console.error(err);
  }
})();
