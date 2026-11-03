import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  loadCourse,
  loadHeights,
  loadIndex,
  lonLatToLocal,
  type Course,
  type CourseIndexEntry,
  type Hole,
  type Tee,
  type XY,
} from "./course";
import { buildHoleScene, type HoleScene } from "./hole";
import {
  adviseClub,
  defaultSpread,
  dropBetween,
  loadBag,
  missLine,
  planShot,
  playsLikeYd,
  saveBag,
  yardsBetween,
  type Bag,
  type ShotPlan,
  type Surface,
} from "./shot";
import { currentRound, deleteRound, finishRound, pastRounds, setScore, startRound, toPar, totals, type Round } from "./round";
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
  /** Where each played shot finished on this hole; the ball lies at the last one, or on the tee. */
  trail: XY[];
  /** Where the player is aiming, once they tap or drag; null aims down the line of play. */
  target: XY | null;
  plan: ShotPlan | null;
  /** Live GPS position in the course frame, once it's on the course. */
  gps: { p: XY; accM: number } | null;
  gpsOn: boolean;
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
  book: localStorage.getItem(BOOK_KEY) !== "0",
  bag: loadBag(),
  club: 0,
  trail: [],
  target: null,
  plan: null,
  gps: null,
  gpsOn: false,
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

/** Front / middle / back of the green from where the ball is now. */
function greenYards(ball: XY, hole: Hole, tee: Tee): { f: number; m: number; b: number; plays: number } {
  const fromTee = onTee() && !gpsLive();
  if (fromTee) return { f: tee.front_yd, m: tee.middle_yd, b: tee.back_yd, plays: playsLike(tee) };
  const g = hole.green;
  const m = yardsBetween(ball, g.middle);
  return {
    f: yardsBetween(ball, g.front),
    m,
    b: yardsBetween(ball, g.back),
    plays: state.grid ? playsLikeYd(state.grid, ball, g.middle) : m,
  };
}

/** The next one or two hazards on the way, with yards from the ball. */
function hazardsAhead(ball: XY, hole: Hole, tee: Tee): { kind: string; yd: number }[] {
  const features = new Map(state.course?.features.map((f) => [f.id, f]) ?? []);
  const toGreen = yardsBetween(ball, hole.green.middle);
  const out: { kind: string; yd: number; greenside: boolean }[] = [];
  for (const h of tee.hazards) {
    const f = features.get(h.feature);
    if (!f || f.geometry.type === "Point" || f.geometry.type === "LineString") continue;
    const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    if (!ring?.length) continue;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of ring) {
      cx += x;
      cy += y;
    }
    cx /= ring.length;
    cy /= ring.length;
    const yd = yardsBetween(ball, [cx, cy]);
    if (yd < 15 || yd > toGreen + 15) continue;
    out.push({ kind: h.kind, yd, greenside: h.greenside });
  }
  return out
    .sort((a, b) => Number(a.greenside) - Number(b.greenside) || a.yd - b.yd)
    .filter((h, i, arr) => i === arr.findIndex((x) => x.kind === h.kind && Math.abs(x.yd - h.yd) < 12))
    .slice(0, 2)
    .map(({ kind, yd }) => ({ kind, yd }));
}

function fmbRow(g: { f: number; m: number; b: number; plays: number }) {
  const plays = Math.abs(g.plays - g.m) >= 2 ? `<span class="plays">Plays ${Math.round(g.plays)}</span>` : "";
  return `<div class="fmb"><span>F ${Math.round(g.f)}</span><span class="mid">${Math.round(g.m)}</span><span>B ${Math.round(g.b)}</span>${plays}</div>`;
}

function renderChrome() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const tee = teeFor(hole);
  $("hole-num").textContent = `Hole ${hole.number}`;
  $("hole-par").textContent = hole.par ? ` · Par ${hole.par}` : "";
  $("hole-hcp").textContent = "";
  $("tee-chip").textContent = course.tee_sets.find((s) => s.key === state.teeSet)?.label ?? "Tee";
  document.body.classList.toggle("book", state.book);
  $("clubs").hidden = !state.book;
  renderScoreBug();
  const card = $("card");
  const live = gpsLive();
  card.classList.toggle("stale", live && state.gps!.accM > 9);
  const ball = ballPoint()!;
  const green = greenYards(ball, hole, tee);
  const hazards = hazardsAhead(ball, hole, tee)
    .map((h) => `<span class="hz ${h.kind}">${h.kind === "water" ? "Water" : "Bunker"} ${Math.round(h.yd)}</span>`)
    .join("");
  const where = live
    ? `<div class="from"><span class="gps-dot"></span>GPS ±${Math.round(state.gps!.accM / 0.9144)} yd</div>`
    : state.trail.length
      ? `<div class="from">Shot ${state.trail.length + 1}</div>`
      : "";
  const canHit = !live && (state.plan || state.target);
  const actions = [
    canHit ? `<button data-act="hit">Play it</button>` : "",
    !live && state.trail.length ? `<button data-act="undo">Undo</button>` : "",
    state.target ? `<button data-act="clear" aria-label="Clear target">✕</button>` : "",
  ].join("");
  const actionRow = actions ? `<div class="actions">${actions}</div>` : "";

  if (state.book && state.plan) {
    const p = state.plan;
    const hero = state.target ? Math.round(p.playsYd) : Math.round(p.carryYd);
    const heroNote = state.target
      ? Math.abs(p.playsYd - p.distYd) >= 2
        ? `plays · ${Math.round(p.distYd)} yd`
        : "to target"
      : p.leavesYd > 12
        ? `carry · ${Math.round(p.leavesYd)} left`
        : "carry · pin high";
    const advice = missLine(p, state.bag.miss);
    const top = p.mix[0];
    card.innerHTML = `
      <div class="hit-club">Hit <b>${p.club.name}</b></div>
      <div class="big">${hero}<small>${heroNote}</small></div>
      <div class="miss-line" style="--dot:${top ? SURFACE_DOT[top.surface] : "#fff"}">${advice}</div>
      ${fmbRow(green)}
      ${hazards ? `<div class="hazards">${hazards}</div>` : ""}
      ${where}${actionRow}`;
  } else if (state.target && state.grid) {
    const dist = yardsBetween(ball, state.target);
    const plays = playsLikeYd(state.grid, ball, state.target);
    const left = yardsBetween(state.target, hole.green.middle);
    card.innerHTML = `
      <div class="eyebrow">Target</div>
      <div class="big">${Math.round(Math.abs(plays - dist) >= 2 ? plays : dist)}<small>${
        Math.abs(plays - dist) >= 2 ? `plays · ${Math.round(dist)} yd` : "yd"
      }</small></div>
      <div class="leaves">${left > 12 ? `${Math.round(left)} to centre` : "Pin high"}</div>
      ${fmbRow(green)}
      ${hazards ? `<div class="hazards">${hazards}</div>` : ""}
      ${where}${actionRow}`;
  } else {
    card.innerHTML = `
      <div class="eyebrow">Green</div>
      <div class="big">${Math.round(Math.abs(green.plays - green.m) >= 2 ? green.plays : green.m)}<small>${
        Math.abs(green.plays - green.m) >= 2 ? `plays · ${Math.round(green.m)} yd` : "to centre"
      }</small></div>
      ${fmbRow(green)}
      ${hazards ? `<div class="hazards">${hazards}</div>` : ""}
      ${where}${actionRow}`;
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
  retargetForClub();
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

const gpsLive = () => state.gpsOn && !!state.gps;

/** Where the next shot is played from: you on GPS, else where the last shot finished, else the tee. */
function ballPoint(): XY | null {
  const { hole } = state;
  if (!hole) return null;
  if (gpsLive()) return state.gps!.p;
  return state.trail.at(-1) ?? teeFor(hole).point;
}

const onTee = () => !gpsLive() && !state.trail.length;

function updateShot(samples?: number) {
  const { course, hole, grid, scene: hs } = state;
  if (!course || !hole || !grid || !hs) return;
  const club = state.bag.clubs[state.club];
  const ball = ballPoint()!;
  hs.setFrom(onTee() && !gpsLive() ? null : ball);
  state.plan = state.book && club?.enabled ? planShot(course, hole, teeFor(hole), grid, ball, club, state.bag.miss, state.target, samples) : null;
  hs.setShot(state.plan);
  const aim = state.plan?.aim ?? state.target;
  hs.setAim(
    aim ? { ball, target: aim, distYd: yardsBetween(ball, aim), leavesYd: yardsBetween(aim, hole.green.middle), flight: !!state.plan } : null,
  );
  hs.setTrail(gpsLive() || !state.trail.length ? [] : [teeFor(hole).point, ...state.trail]);
  renderChrome();
}

/** Pick the club for the current ball position and redraw. */
function suggestAndUpdate() {
  const { course, hole, grid } = state;
  if (!course || !hole || !grid) return;
  if (state.book) {
    const advice = adviseClub(course, hole, teeFor(hole), grid, ballPoint()!, state.bag, state.bag.miss, state.target, onTee());
    state.club = advice.index;
    state.plan = advice.plan;
    renderClubStrip();
    const hs = state.scene;
    if (hs) {
      hs.setFrom(onTee() && !gpsLive() ? null : advice.plan.ball);
      hs.setShot(state.plan);
      hs.setAim({
        ball: state.plan.ball,
        target: state.plan.aim,
        distYd: state.plan.distYd,
        leavesYd: state.plan.leavesYd,
        flight: true,
      });
      hs.setTrail(gpsLive() || !state.trail.length ? [] : [teeFor(hole).point, ...state.trail]);
    }
    renderChrome();
    return;
  }
  state.plan = null;
  updateShot();
}

/** Move the target. Full club advice runs when the drag ends; mid-drag keeps the current club. */
function aimAt(p: XY, samples?: number) {
  const { course, hole, grid } = state;
  state.target = p;
  if (state.book && course && hole && grid) {
    const dragging = samples !== undefined && samples < 200;
    if (dragging) {
      const club = state.bag.clubs[state.club];
      state.plan = planShot(course, hole, teeFor(hole), grid, ballPoint()!, club, state.bag.miss, p, samples);
    } else {
      const advice = adviseClub(course, hole, teeFor(hole), grid, ballPoint()!, state.bag, state.bag.miss, p, onTee());
      state.club = advice.index;
      state.plan = advice.plan;
      renderClubStrip();
    }
    const hs = state.scene;
    if (hs && state.plan) {
      hs.setShot(state.plan);
      hs.setAim({
        ball: state.plan.ball,
        target: state.plan.aim,
        distYd: state.plan.distYd,
        leavesYd: state.plan.leavesYd,
        flight: true,
      });
    }
    renderChrome();
    return;
  }
  updateShot(samples);
}

/** Keep the aim's direction but move it to where the chosen club plays to. */
function retargetForClub() {
  const { grid, target } = state;
  const club = state.bag.clubs[state.club];
  if (!target || !grid || !club) return;
  const ball = ballPoint()!;
  const len = Math.hypot(target[0] - ball[0], target[1] - ball[1]) || 1;
  const dir: XY = [(target[0] - ball[0]) / len, (target[1] - ball[1]) / len];
  let carryM = club.carry * 0.9144;
  let p: XY = target;
  for (let i = 0; i < 3; i++) {
    p = [ball[0] + dir[0] * carryM, ball[1] + dir[1] * carryM];
    carryM = (club.carry + dropBetween(grid, ball, p) / 3) * 0.9144;
  }
  state.target = p;
}

/** Play the planned shot: the ball finishes at the target and the next shot starts there. */
function hit() {
  const to = state.plan?.aim ?? state.target;
  if (!to || gpsLive()) return;
  state.trail.push(to);
  state.target = null;
  suggestAndUpdate();
}

function undo() {
  if (!state.trail.length) return;
  state.trail.pop();
  state.target = null;
  suggestAndUpdate();
}

function setBook(on: boolean) {
  state.book = on;
  localStorage.setItem(BOOK_KEY, on ? "1" : "0");
  suggestAndUpdate();
}

let toastTimer = 0;
function toast(text: string, ms = 900) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), ms);
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
  if (mode === "tee" && (state.trail.length || state.target) && !gpsLive()) {
    state.trail = [];
    state.target = null;
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
  else if (e.type === "pointerup" && dt < 350 && Math.hypot(dx, dy) < 8) {
    const p = groundAt(e.clientX, e.clientY);
    if (p) aimAt(p);
  }
};

function groundAt(x: number, y: number): XY | null {
  const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  return state.scene?.pick(ndc, camera) ?? null;
}
renderer.domElement.addEventListener("pointerup", endPointer);
renderer.domElement.addEventListener("pointercancel", endPointer);

// --- dragging the target -------------------------------------------------

/** Grab offset so the target stays where it was under the finger, not jump to the fingertip. */
let drag: { id: number; dx: number; dy: number; el: HTMLElement } | null = null;
let dragFrame = 0;
let dragAt: XY | null = null;

function onDragMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const p = groundAt(e.clientX + drag.dx, e.clientY + drag.dy);
  if (!p) return;
  dragAt = p;
  if (!dragFrame)
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (dragAt) aimAt(dragAt, 150);
    });
}

function onDragEnd(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const el = drag.el;
  drag = null;
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
  controls.enabled = true;
  el.classList.remove("dragging");
  if (dragAt) aimAt(dragAt);
  dragAt = null;
}

function bindTarget(el: HTMLElement) {
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const r = el.getBoundingClientRect();
    drag = { id: e.pointerId, dx: r.left + r.width / 2 - e.clientX, dy: r.top + r.height / 2 - e.clientY, el };
    controls.enabled = false;
    el.classList.add("dragging");
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  });
}

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
    <button class="row" data-book><span>My book<span class="hint">Club advice and likely miss for every shot</span></span><span class="switch${state.book ? " on" : ""}"></span></button>
    <button class="row" data-clubs><span>My bag<span class="hint">Your carries, miss spread and usual miss</span></span><span class="muted">›</span></button>
    <button class="row" data-score><span>Scorecard<span class="hint">${roundHere() ? "Round in progress" : "Start a round or see past scores"}</span></span><span class="muted">›</span></button>
    <button class="row" data-gps><span>Live GPS<span class="hint">Yardages from where you are on the course</span></span><span class="switch${state.gpsOn ? " on" : ""}"></span></button>
    <h4>Courses</h4>${rows}`,
    (body) => {
      body.querySelector("[data-book]")!.addEventListener("click", (e) => {
        const sw = (e.currentTarget as HTMLElement).querySelector(".switch")!;
        sw.classList.toggle("on", !state.book);
        setBook(!state.book);
        window.setTimeout(closeSheet, 220);
      });
      body.querySelector("[data-clubs]")!.addEventListener("click", clubsSheet);
      body.querySelector("[data-score]")!.addEventListener("click", scoreSheet);
      body.querySelector("[data-gps]")!.addEventListener("click", () => {
        closeSheet();
        toggleGps();
      });
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
    `<h3>My bag</h3>
    <p class="sub">Your carries power the book. Two out of three shots land inside ± left/right and ± long/short.</p>
    <h4>Usual miss</h4><div class="segmented">${miss}</div>
    <h4>Clubs</h4>
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
        state.trail = [];
        state.target = null;
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
$("card").addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "hit") hit();
  else if (act === "undo") undo();
  else if (act === "clear") {
    state.target = null;
    updateShot();
  } else infoSheet();
});
$("score-bug").addEventListener("click", scoreSheet);
$("gps").addEventListener("click", toggleGps);
$("credits").addEventListener("click", creditsSheet);

// --- GPS -----------------------------------------------------------------

let watchId: number | null = null;
let needHole = true;
/** Where the club was last suggested from, so walking re-suggests only every few metres. */
let suggestedAt: XY | null = null;

function segDist(p: XY, a: XY, b: XY) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function nearestHole(course: Course, p: XY): Hole {
  let best = course.holes[0];
  let bestD = Infinity;
  for (const h of course.holes) {
    const line = [...h.line, h.green.middle];
    for (let i = 0; i < line.length - 1; i++) {
      const d = segDist(p, line[i], line[i + 1]);
      if (d < bestD) [best, bestD] = [h, d];
    }
  }
  return best;
}

function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  state.gpsOn = false;
  state.gps = null;
  $("gps").classList.remove("active", "pending");
  state.scene?.setMe(null);
  suggestAndUpdate();
}

function applyFix(c: GeolocationCoordinates) {
  const { course } = state;
  if (!course || !state.gpsOn) return;
  const p = lonLatToLocal(course, c.longitude, c.latitude);
  const [x0, y0, x1, y1] = course.bounds.local;
  const margin = 150;
  if (p[0] < x0 - margin || p[0] > x1 + margin || p[1] < y0 - margin || p[1] > y1 + margin) {
    const miles = Math.hypot(...p) / 1609.34;
    toast(`You're ${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi from ${course.name}`, 2600);
    stopGps();
    return;
  }
  state.gps = { p, accM: c.accuracy };
  $("gps").classList.remove("pending");
  $("gps").classList.add("active");
  if (needHole) {
    needHole = false;
    const hole = nearestHole(course, p);
    if (hole.number !== state.hole?.number) {
      showHole(hole.number, true);
      return;
    }
  }
  state.trail = [];
  state.scene?.setMe(state.gps);
  if (!suggestedAt || Math.hypot(p[0] - suggestedAt[0], p[1] - suggestedAt[1]) > 5) {
    suggestedAt = p;
    suggestAndUpdate();
  } else updateShot();
}

function toggleGps() {
  if (state.gpsOn) return stopGps();
  if (!("geolocation" in navigator)) return toast("This browser can't share your location");
  state.gpsOn = true;
  needHole = true;
  suggestedAt = null;
  $("gps").classList.add("pending");
  toast("Finding you…");
  watchId = navigator.geolocation.watchPosition(
    (pos) => applyFix(pos.coords),
    (err) => {
      toast(err.code === err.PERMISSION_DENIED ? "Location is turned off for this site" : "Couldn't get a GPS fix", 2600);
      stopGps();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
  );
}

// --- scorecard -----------------------------------------------------------

const roundHere = () => {
  const r = currentRound();
  return r && r.course === state.course?.slug ? r : null;
};

function renderScoreBug() {
  const r = roundHere();
  const bug = $("score-bug");
  bug.hidden = !r;
  if (!r) return;
  const t = totals(r);
  bug.innerHTML = t.played ? `<b>${toPar(t)}</b><span>thru ${t.played}</span>` : `<b>E</b><span>Hole ${state.hole?.number ?? 1}</span>`;
}

function scoreClass(strokes: number, par: number | null) {
  if (!par) return "";
  const d = strokes - par;
  return d <= -2 ? "eagle" : d === -1 ? "birdie" : d === 1 ? "bogey" : d >= 2 ? "double" : "par";
}

function cardTable(r: Round, holes: number[], label: string) {
  const t = totals(r, holes);
  const cells = (f: (n: number) => string) => holes.map((n) => `<td data-hole="${n}">${f(n)}</td>`).join("");
  return `<table class="scorecard">
    <tr class="h"><th>Hole</th>${cells((n) => `${n}`)}<th>${label}</th></tr>
    <tr class="p"><th>Par</th>${cells((n) => `${r.pars[n] ?? "–"}`)}<th>${holes.reduce((s, n) => s + (r.pars[n] ?? 0), 0)}</th></tr>
    <tr class="s"><th>Score</th>${cells((n) => {
      const s = r.scores[n];
      return s ? `<span class="${scoreClass(s.strokes, r.pars[n])}">${s.strokes}</span>` : "";
    })}<th>${t.played ? t.strokes : ""}</th></tr>
    <tr class="pt"><th>Putts</th>${cells((n) => `${r.scores[n]?.putts ?? ""}`)}<th>${t.played ? t.putts : ""}</th></tr>
  </table>`;
}

function scoreSheet() {
  const { course, hole } = state;
  if (!course || !hole) return;
  const r = roundHere();
  const teeLabel = course.tee_sets.find((s) => s.key === state.teeSet)?.label ?? "";
  if (!r) {
    const past = pastRounds()
      .slice(0, 12)
      .map((p) => {
        const t = totals(p);
        const date = new Date(p.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        return `<div class="row"><span>${p.courseName}<br><span class="muted">${date} · ${p.tee} · ${t.played} holes</span></span><span><b>${t.strokes}</b> <span class="muted">${toPar(t)}</span> <button class="x" data-del="${p.id}" aria-label="Delete round">✕</button></span></div>`;
      })
      .join("");
    openSheet(
      `<h3>Scorecard</h3>
      <p class="sub">${course.name}${teeLabel ? ` · ${teeLabel} tees` : ""}</p>
      <button class="primary" data-start>Start a round</button>
      ${past ? `<h4>Past rounds</h4>${past}` : ""}`,
      (body) => {
        body.querySelector("[data-start]")!.addEventListener("click", () => {
          const pars = Object.fromEntries(course.holes.map((h) => [h.number, h.par]));
          const other = currentRound();
          startRound(course.slug, course.name, teeLabel, pars);
          if (other) toast(`Saved your round at ${other.courseName}`, 2000);
          renderScoreBug();
          scoreSheet();
        });
        body.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
          b.addEventListener("click", () => {
            deleteRound(b.dataset.del!);
            scoreSheet();
          }),
        );
      },
    );
    return;
  }
  const par = hole.par ?? 4;
  const mine = r.scores[hole.number];
  const strokeBtns = Array.from({ length: par + 4 }, (_, i) => i + 1)
    .map((n) => `<button data-strokes="${n}" class="${scoreClass(n, hole.par)}${mine?.strokes === n ? " active" : ""}">${n}</button>`)
    .join("");
  const puttBtns = [0, 1, 2, 3, 4]
    .map((n) => `<button data-putts="${n}" class="${mine?.putts === n ? "active" : ""}">${n}${n === 4 ? "+" : ""}</button>`)
    .join("");
  const t = totals(r);
  const front = Array.from({ length: 9 }, (_, i) => i + 1);
  const back = Array.from({ length: 9 }, (_, i) => i + 10);
  openSheet(
    `<div class="score-head"><h3>Hole ${hole.number}${hole.par ? ` · Par ${hole.par}` : ""}</h3><span class="total">${t.played ? `${t.strokes} · <b>${toPar(t)}</b>` : ""}</span></div>
    <h4>Strokes</h4><div class="strokes">${strokeBtns}</div>
    <h4>Putts</h4><div class="segmented">${puttBtns}</div>
    <button class="primary" data-next>${hole.number === 18 ? "Done" : `Hole ${hole.number + 1} ›`}</button>
    <h4>Card</h4>
    ${cardTable(r, front, "Out")}${cardTable(r, back, "In")}
    <div class="row"><span>Total</span><span><b>${t.played ? t.strokes : "–"}</b> <span class="muted">${t.played ? `${toPar(t)} thru ${t.played} · ${t.putts} putts` : ""}</span></span></div>
    <button class="link" data-finish>Finish round</button>`,
    (body) => {
      const save = (patch: Partial<{ strokes: number; putts: number | null }>) => {
        const cur = r.scores[hole.number] ?? { strokes: par, putts: null };
        setScore(hole.number, { ...cur, ...patch });
        renderScoreBug();
        scoreSheet();
      };
      body.querySelectorAll<HTMLButtonElement>("[data-strokes]").forEach((b) =>
        b.addEventListener("click", () => save({ strokes: Number(b.dataset.strokes) })),
      );
      body.querySelectorAll<HTMLButtonElement>("[data-putts]").forEach((b) =>
        b.addEventListener("click", () => save({ putts: Number(b.dataset.putts) })),
      );
      body.querySelector("[data-next]")!.addEventListener("click", () => {
        closeSheet();
        if (hole.number < 18) showHole(hole.number + 1, true);
      });
      body.querySelectorAll<HTMLElement>("td[data-hole]").forEach((td) =>
        td.addEventListener("click", async () => {
          const n = Number(td.dataset.hole);
          if (n !== state.hole?.number) await showHole(n);
          scoreSheet();
        }),
      );
      body.querySelector("[data-finish]")!.addEventListener("click", () => {
        finishRound();
        closeSheet();
        renderScoreBug();
        toast(t.played ? `Saved · ${t.strokes} (${toPar(t)})` : "Round discarded", 2000);
      });
    },
  );
}

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
  state.trail = [];
  state.target = null;
  state.scene = buildHoleScene(course, hole, grid, resolution, teeFor(hole), state.exag);
  bindTarget(state.scene.targetElement);
  if (state.gps) state.scene.setMe(state.gps);
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
