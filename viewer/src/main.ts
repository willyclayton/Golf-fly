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
import { defaultSpread, loadBag, planShot, saveBag, suggestClub, SURFACE_LABELS, type Bag, type ShotPlan, type Surface } from "./shot";
import type { HeightGrid } from "./course";
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
  grid: HeightGrid | null;
  /** Yardage book: club strip, shot plan and miss pattern. */
  book: boolean;
  bag: Bag;
  club: number;
  /** Where the next shot is hit from; null means the tee. */
  ball: XY | null;
  plan: ShotPlan | null;
}
const BOOK_KEY = "golffly.book";
const state: State = {
  courses: [],
  course: null,
  hole: null,
  scene: null,
  teeSet: "",
  exag: 1.5,
  mode: "tee",
  animation: null,
  grid: null,
  book: localStorage.getItem(BOOK_KEY) === "1",
  bag: loadBag(),
  club: 0,
  ball: null,
  plan: null,
};
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
  document.body.classList.toggle("book", state.book);
  $("clubs").hidden = !state.book;
  if (state.book && state.plan) {
    const p = state.plan;
    const drop =
      Math.abs(p.dropFt) >= 6
        ? `<div class="from">Flies ${Math.round(p.effectiveYd)} with the ${Math.round(Math.abs(p.dropFt))} ft ${p.dropFt > 0 ? "drop" : "rise"}</div>`
        : "";
    const mix = p.mix
      .slice(0, 4)
      .map((m) => `<span style="--dot:${SURFACE_DOT[m.surface]}">${SURFACE_LABELS[m.surface]} ${m.pct}%</span>`)
      .join("");
    const leaves = p.leavesYd > 12 ? `${Math.round(p.leavesYd)} to centre` : "Pin high";
    $("card").innerHTML = `
      <div class="club-name">${p.club.name}</div>
      <div class="big">${Math.round(p.carryYd)}<small> carry</small></div>
      <div class="leaves">${leaves}</div>
      <div class="mix">${mix}</div>
      ${drop}
      ${state.ball ? `<div class="from">From your spot · tap the tee view to reset</div>` : ""}`;
  } else {
    const plays = Math.abs(tee.elev_change_ft) >= 3 ? `<div class="plays">Plays ${playsLike(tee)}</div>` : "";
    $("card").innerHTML = `
      <div class="eyebrow">Centre</div>
      <div class="big">${Math.round(tee.middle_yd)}</div>
      <div class="fb">F ${Math.round(tee.front_yd)} · B ${Math.round(tee.back_yd)}</div>
      ${plays}`;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => b.classList.toggle("active", b.dataset.cam === state.mode));
}

const SURFACE_DOT: Record<Surface, string> = {
  fairway: "#ffffff",
  green: "#9fe07a",
  rough: "#ffe08a",
  trees: "#ff9f43",
  sand: "#f3e1a8",
  water: "#4aa3df",
  off: "#ff4d4d",
};

// --- yardage book --------------------------------------------------------

const clubTrack = $("club-track");
const enabledClubs = () => state.bag.clubs.map((c, i) => ({ c, i })).filter(({ c }) => c.enabled);

function renderClubStrip() {
  clubTrack.innerHTML =
    enabledClubs()
      .map(({ c, i }) => `<button data-club="${i}" class="${i === state.club ? "active" : ""}"><b>${c.name}</b><span>${Math.round(c.carry)}</span></button>`)
      .join("") + `<button class="edit" data-edit>Edit</button>`;
  centerActiveClub("auto");
}

function centerActiveClub(behavior: ScrollBehavior) {
  const el = clubTrack.querySelector<HTMLElement>(`[data-club="${state.club}"]`);
  if (!el) return;
  ignoreScroll = true;
  clubTrack.scrollTo({ left: el.offsetLeft - (clubTrack.clientWidth - el.offsetWidth) / 2, behavior });
  window.setTimeout(() => (ignoreScroll = false), behavior === "smooth" ? 450 : 50);
}

function selectClub(i: number, scroll = true) {
  if (i === state.club && state.plan) return;
  state.club = i;
  clubTrack.querySelectorAll<HTMLElement>("[data-club]").forEach((b) => b.classList.toggle("active", Number(b.dataset.club) === i));
  if (scroll) centerActiveClub("smooth");
  updateShot();
}

let ignoreScroll = false;
let scrollTimer = 0;
clubTrack.addEventListener("scroll", () => {
  if (ignoreScroll) return;
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    const mid = clubTrack.scrollLeft + clubTrack.clientWidth / 2;
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    clubTrack.querySelectorAll<HTMLElement>("[data-club]").forEach((b) => {
      const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid);
      if (d < bestD) [best, bestD] = [b, d];
    });
    if (best) selectClub(Number((best as HTMLElement).dataset.club), false);
  }, 110);
});
clubTrack.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (b.dataset.edit !== undefined) clubsSheet();
  else selectClub(Number(b.dataset.club));
});

function ballPoint(): XY | null {
  const { hole } = state;
  return hole ? (state.ball ?? teeFor(hole).point) : null;
}

function updateShot() {
  const { course, hole, grid, scene: hs } = state;
  if (!course || !hole || !grid || !hs) return;
  const club = state.bag.clubs[state.club];
  if (!state.book || !club?.enabled) {
    state.plan = null;
    hs.setShot(null);
  } else {
    state.plan = planShot(course, hole, teeFor(hole), grid, ballPoint()!, club, state.bag.miss);
    hs.setShot(state.plan);
  }
  renderChrome();
}

/** Pick the club for the current ball position and redraw. */
function suggestAndUpdate() {
  const { hole } = state;
  if (!hole) return;
  const ball = ballPoint()!;
  let toGreen = Math.hypot(hole.green.middle[0] - ball[0], hole.green.middle[1] - ball[1]) / 0.9144;
  if (state.grid) {
    const dropFt = (state.grid.heightAt(ball[0], ball[1]) - state.grid.heightAt(...hole.green.middle)) / 0.3048;
    if (Number.isFinite(dropFt)) toGreen -= dropFt / 3;
  }
  state.club = suggestClub(state.bag, toGreen, !state.ball, hole.par);
  if (state.book) renderClubStrip();
  state.plan = null;
  updateShot();
}

function setBook(on: boolean) {
  state.book = on;
  localStorage.setItem(BOOK_KEY, on ? "1" : "0");
  suggestAndUpdate();
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
  if (mode === "tee" && state.ball) {
    state.ball = null;
    suggestAndUpdate();
  }
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
  const dt = performance.now() - swipe.t;
  swipe = null;
  if (dt < 300 && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * Math.tan(Math.PI / 6)) step(dx < 0 ? 1 : -1);
  else if (e.type === "pointerup" && dt < 350 && Math.hypot(dx, dy) < 8 && state.book) hitFrom(e.clientX, e.clientY);
};

/** Yardage book: tap the ground to play the next shot from there. */
function hitFrom(x: number, y: number) {
  const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  const p = state.scene?.pick(ndc, camera);
  if (!p) return;
  state.ball = p;
  suggestAndUpdate();
}
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

function menuSheet() {
  const rows = state.courses
    .map(
      (c) =>
        `<button class="row${c.slug === state.course?.slug ? " selected" : ""}" data-slug="${c.slug}"><span>${c.name}<br><span class="muted">${c.city ?? ""}</span></span></button>`,
    )
    .join("");
  openSheet(
    `<h3>Settings</h3>
    <button class="row" data-book><span>Yardage book<span class="hint">Swipe through your clubs to see where each one lands and misses</span></span><span class="switch${state.book ? " on" : ""}"></span></button>
    <button class="row" data-clubs><span>My clubs<span class="hint">Carries and miss spread</span></span><span class="muted">›</span></button>
    <h4>Courses</h4>${rows}`,
    (body) => {
      body.querySelector("[data-book]")!.addEventListener("click", (e) => {
        const sw = (e.currentTarget as HTMLElement).querySelector(".switch")!;
        sw.classList.toggle("on", !state.book);
        setBook(!state.book);
        window.setTimeout(closeSheet, 220);
      });
      body.querySelector("[data-clubs]")!.addEventListener("click", clubsSheet);
      body.querySelectorAll<HTMLButtonElement>("[data-slug]").forEach((b) =>
        b.addEventListener("click", () => {
          closeSheet();
          if (b.dataset.slug !== state.course?.slug) showCourse(b.dataset.slug!);
        }),
      );
    },
  );
}

function clubsSheet() {
  const bag = state.bag;
  const rows = bag.clubs
    .map(
      (c, i) => `<tr data-i="${i}">
        <td class="${c.enabled ? "" : "off"}"><label><input type="checkbox" data-f="enabled" ${c.enabled ? "checked" : ""}>${c.name}</label></td>
        <td><input type="number" inputmode="numeric" min="20" max="350" data-f="carry" value="${c.carry}"></td>
        <td><input type="number" inputmode="numeric" min="1" max="80" data-f="side" value="${c.side}"></td>
        <td><input type="number" inputmode="numeric" min="1" max="60" data-f="depth" value="${c.depth}"></td>
      </tr>`,
    )
    .join("");
  const miss = (["left", "straight", "right"] as const)
    .map((m) => `<button data-miss="${m}" class="${bag.miss === m ? "active" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`)
    .join("");
  openSheet(
    `<h3>My clubs</h3>
    <p class="sub">Carry in yards, and how far your misses spread: two out of three shots land inside ± left/right and ± long/short.</p>
    <h4>Usual miss</h4><div class="segmented">${miss}</div>
    <h4>Bag</h4>
    <table class="bag"><tr><th>Club</th><th>Carry</th><th>± L/R</th><th>± Long</th></tr>${rows}</table>
    <button class="link" data-reset>Reset spreads to typical for each carry</button>`,
    (body) => {
      const save = () => {
        saveBag(bag);
        if (!bag.clubs[state.club]?.enabled) state.club = enabledClubs()[0]?.i ?? 0;
        if (state.book) renderClubStrip();
        updateShot();
      };
      body.querySelectorAll<HTMLInputElement>("input").forEach((input) =>
        input.addEventListener("change", () => {
          const i = Number(input.closest("tr")!.dataset.i);
          const club = bag.clubs[i];
          const f = input.dataset.f as "carry" | "side" | "depth" | "enabled";
          if (f === "enabled") {
            club.enabled = input.checked;
            input.closest("td")!.classList.toggle("off", !input.checked);
          } else {
            const v = Number(input.value);
            if (Number.isFinite(v) && v > 0) club[f] = Math.round(v);
            input.value = String(club[f]);
          }
          save();
        }),
      );
      body.querySelectorAll<HTMLButtonElement>("[data-miss]").forEach((b) =>
        b.addEventListener("click", () => {
          bag.miss = b.dataset.miss as Bag["miss"];
          body.querySelectorAll("[data-miss]").forEach((x) => x.classList.toggle("active", x === b));
          save();
        }),
      );
      body.querySelector("[data-reset]")!.addEventListener("click", () => {
        for (const c of bag.clubs) Object.assign(c, defaultSpread(c.carry));
        save();
        clubsSheet();
      });
    },
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
        state.ball = null;
        suggestAndUpdate();
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

$("menu").addEventListener("click", menuSheet);
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
  state.grid = grid;
  state.ball = null;
  state.scene = buildHoleScene(course, hole, grid, resolution, teeFor(hole), state.exag);
  sun.position.copy(state.scene.sunDirection).multiplyScalar(1000);
  scene.add(state.scene.group);
  history.replaceState(null, "", `#${course.slug}/${hole.number}`);
  state.mode = "tee";
  suggestAndUpdate();
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

window.addEventListener("hashchange", () => {
  const [slug, hole] = decodeURIComponent(location.hash.slice(1)).split("/");
  const n = Number(hole) || 1;
  if (!state.courses.some((c) => c.slug === slug)) return;
  if (slug !== state.course?.slug) showCourse(slug, n);
  else if (n !== state.hole?.number) showHole(n);
});

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
  const labels = state.scene?.labels();
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
