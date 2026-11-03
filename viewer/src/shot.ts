// Yardage-book shot planning: club carries, aim, landing spot, miss ellipse and what the misses find.

import type { Course, Feature, Geometry, HeightGrid, Hole, Tee, XY } from "./course";

const YD = 0.9144;
const FT = 0.3048;

export interface Club {
  name: string;
  carry: number; // yd
  /** Half-width of the 68% miss ellipse, left/right, in yd. */
  side: number;
  /** Half-length of the 68% miss ellipse, long/short, in yd. */
  depth: number;
  enabled: boolean;
}

export type Miss = "left" | "straight" | "right";

export interface Bag {
  clubs: Club[];
  miss: Miss;
}

const DEFAULT_CARRIES: [string, number][] = [
  ["Driver", 230],
  ["3 wood", 210],
  ["5 wood", 195],
  ["4 hybrid", 185],
  ["5 iron", 170],
  ["6 iron", 160],
  ["7 iron", 150],
  ["8 iron", 140],
  ["9 iron", 130],
  ["PW", 120],
  ["GW", 105],
  ["SW", 90],
  ["LW", 70],
];

/** Typical amateur spread: wider for long clubs, as a share of carry. */
export function defaultSpread(carry: number): { side: number; depth: number } {
  return { side: Math.round(carry * 0.09), depth: Math.round(carry * 0.06) };
}

const STORAGE_KEY = "golffly.bag.v1";

export function loadBag(): Bag {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Bag | null;
    if (saved?.clubs?.length) return saved;
  } catch {
    // fall through to the default bag
  }
  return {
    clubs: DEFAULT_CARRIES.map(([name, carry]) => ({ name, carry, ...defaultSpread(carry), enabled: true })),
    miss: "straight",
  };
}

export function saveBag(bag: Bag) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
}

// --- landing surfaces ------------------------------------------------------

export type Surface = "water" | "sand" | "green" | "fairway" | "trees" | "off" | "rough";

export const SURFACE_LABELS: Record<Surface, string> = {
  water: "Water",
  sand: "Sand",
  green: "Green",
  fairway: "Fairway",
  trees: "Trees",
  off: "Off course",
  rough: "Rough",
};

interface Area {
  surface: Surface;
  polys: XY[][][];
  box: [number, number, number, number];
}

function rings(g: Geometry): XY[][][] {
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

function insideRing(ring: XY[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const insidePoly = (poly: XY[][], x: number, y: number) =>
  insideRing(poly[0], x, y) && !poly.slice(1).some((h) => insideRing(h, x, y));

class SurfaceMap {
  private areas: Area[] = [];
  private outline: XY[][][];
  private treeCells = new Map<string, XY[]>();
  private static TREE_R = 4;

  constructor(course: Course) {
    const kinds: Record<string, Surface> = { water: "water", bunker: "sand", green: "green", fairway: "fairway", tee: "fairway", trees: "trees" };
    for (const f of course.features) {
      const surface = kinds[f.kind];
      if (surface) this.addArea(surface, f);
      if (f.kind === "tree" && f.geometry.type === "Point") {
        const [x, y] = f.geometry.coordinates;
        const key = this.cell(x, y);
        this.treeCells.set(key, [...(this.treeCells.get(key) ?? []), [x, y]]);
      }
    }
    const order: Surface[] = ["water", "sand", "green", "fairway", "trees"];
    this.areas.sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));
    this.outline = rings(course.outline);
  }

  private cell(x: number, y: number) {
    return `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
  }

  private addArea(surface: Surface, f: Feature) {
    const polys = rings(f.geometry);
    const pts = polys.flatMap((p) => p[0]);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    this.areas.push({ surface, polys, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }

  private nearTree(x: number, y: number): boolean {
    const cx = Math.floor(x / 8);
    const cy = Math.floor(y / 8);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [tx, ty] of this.treeCells.get(`${cx + i},${cy + j}`) ?? []) {
          if (Math.hypot(tx - x, ty - y) < SurfaceMap.TREE_R) return true;
        }
      }
    }
    return false;
  }

  at(x: number, y: number): Surface {
    for (const a of this.areas) {
      const [x0, y0, x1, y1] = a.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (a.polys.some((p) => insidePoly(p, x, y))) return a.surface;
    }
    if (this.nearTree(x, y)) return "trees";
    if (!this.outline.some((p) => insidePoly(p, x, y))) return "off";
    return "rough";
  }
}

const surfaceMaps = new WeakMap<Course, SurfaceMap>();
function surfaceMap(course: Course): SurfaceMap {
  let m = surfaceMaps.get(course);
  if (!m) surfaceMaps.set(course, (m = new SurfaceMap(course)));
  return m;
}

// --- shot plan --------------------------------------------------------------

export interface ShotPlan {
  club: Club;
  ball: XY;
  /** Where the player aims; the miss pattern is centred near it. */
  aim: XY;
  /** Centre of the miss pattern: the aim shifted by the usual miss. */
  land: XY;
  /** Unit vector of the shot, in local metres. */
  dir: XY;
  carryYd: number;
  /** Straight-line yards from the ball to the aim. */
  distYd: number;
  /** distYd allowing about 1 yd per 3 ft of drop or rise. */
  playsYd: number;
  dropFt: number;
  leavesYd: number;
  ellipse: XY[];
  /** Simulated landing spots, for the mix and the scatter. */
  samples: { p: XY; surface: Surface }[];
  mix: { surface: Surface; pct: number }[];
}

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Where the player aims: on the line of play at the club's carry, or the green centre when it reaches. */
function aimPoint(hole: Hole, tee: Tee, ball: XY, carryM: number): XY {
  const mid = hole.green.middle;
  if (dist(ball, mid) <= carryM + 10 * YD) return mid;
  const toGo = dist(ball, mid);
  const path: XY[] = [ball, ...tee.path.filter((p) => dist(p, mid) < toGo - 1)];
  for (let i = 0; i < path.length - 1; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const len = dist(a, b);
    for (let s = 0; s <= len; s += 1) {
      const p: XY = [a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len];
      if (dist(ball, p) >= carryM) return p;
    }
  }
  return mid;
}

function gaussian(rand: () => number): [number, number] {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES = 400;

/** Feet the ground falls from a to b (negative when it rises). */
export function dropBetween(grid: HeightGrid, a: XY, b: XY): number {
  const d = (grid.heightAt(a[0], a[1]) - grid.heightAt(b[0], b[1])) / FT;
  return Number.isFinite(d) ? d : 0;
}

/** Yards from a to b, adjusted about 1 yd per 3 ft of drop or rise. */
export function playsLikeYd(grid: HeightGrid, a: XY, b: XY): number {
  return dist(a, b) / YD - dropBetween(grid, a, b) / 3;
}

export const yardsBetween = (a: XY, b: XY) => dist(a, b) / YD;

/**
 * Plan a shot with a club. Without a target the player aims down the line of play at the
 * club's plays-like carry; with one, the shot is aimed straight at it.
 */
export function planShot(
  course: Course,
  hole: Hole,
  tee: Tee,
  grid: HeightGrid,
  ball: XY,
  club: Club,
  miss: Miss,
  target: XY | null = null,
  sampleCount = SAMPLES,
): ShotPlan {
  const toward = target ?? aimPoint(hole, tee, ball, club.carry * YD);
  const len = dist(ball, toward) || 1;
  const dir: XY = [(toward[0] - ball[0]) / len, (toward[1] - ball[1]) / len];
  const right: XY = [dir[1], -dir[0]];

  let land: XY = target ?? ball;
  if (!target) {
    let effective = club.carry;
    for (let i = 0; i < 3; i++) {
      land = [ball[0] + dir[0] * effective * YD, ball[1] + dir[1] * effective * YD];
      effective = club.carry + dropBetween(grid, ball, land) / 3;
    }
  }
  const aim = land;
  const dropFt = dropBetween(grid, ball, aim);
  const bias = (miss === "right" ? 1 : miss === "left" ? -1 : 0) * club.side * 0.35 * YD;
  const center: XY = [land[0] + right[0] * bias, land[1] + right[1] * bias];
  const sideM = club.side * YD;
  const depthM = club.depth * YD;

  const ellipse: XY[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    const a = Math.cos(t) * sideM;
    const b = Math.sin(t) * depthM;
    ellipse.push([center[0] + right[0] * a + dir[0] * b, center[1] + right[1] * a + dir[1] * b]);
  }

  // The ellipse holds about 68% of shots, which is 1.5 standard deviations in 2D.
  const map = surfaceMap(course);
  const rand = seeded(hole.number * 1009 + Math.round(club.carry) * 17 + Math.round(ball[0] + ball[1]));
  const counts = new Map<Surface, number>();
  const samples: ShotPlan["samples"] = [];
  for (let i = 0; i < sampleCount; i++) {
    const [g1, g2] = gaussian(rand);
    const a = (g1 * sideM) / 1.5;
    const b = (g2 * depthM) / 1.5;
    const p: XY = [center[0] + right[0] * a + dir[0] * b, center[1] + right[1] * a + dir[1] * b];
    const surface = map.at(p[0], p[1]);
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
    samples.push({ p, surface });
  }
  const mix = [...counts.entries()]
    .map(([surface, n]) => ({ surface, pct: Math.round((n / sampleCount) * 100) }))
    .filter((m) => m.pct > 0)
    .sort((a, b) => b.pct - a.pct);

  const distYd = dist(ball, aim) / YD;
  return {
    club,
    ball,
    aim,
    land: center,
    dir,
    carryYd: club.carry,
    distYd,
    playsYd: distYd - dropFt / 3,
    dropFt,
    leavesYd: dist(aim, hole.green.middle) / YD,
    ellipse,
    samples,
    mix,
  };
}

const GOOD: Surface[] = ["fairway", "green"];
const TROUBLE: Surface[] = ["water", "off", "trees", "sand"];

const pctOf = (mix: ShotPlan["mix"], surfaces: Surface[]) =>
  mix.filter((m) => surfaces.includes(m.surface)).reduce((s, m) => s + m.pct, 0);

/** How safe a landing mix is: reward fairway/green, punish water and OB hardest. */
export function safetyScore(mix: ShotPlan["mix"]): number {
  return pctOf(mix, ["fairway"]) + pctOf(mix, ["green"]) * 1.2 - pctOf(mix, ["water"]) * 3 - pctOf(mix, ["off"]) * 3 - pctOf(mix, ["trees"]) * 1.8 - pctOf(mix, ["sand"]) * 1.2;
}

/** One line: where the ball usually finishes, and where the miss finds trouble. */
export function missLine(plan: ShotPlan, miss: Miss): string {
  const top = plan.mix[0];
  const good = pctOf(plan.mix, GOOD);
  const trouble = plan.mix.find((m) => TROUBLE.includes(m.surface) && m.pct >= 8);
  const side = miss === "left" ? "left" : miss === "right" ? "right" : null;
  const name = (s: Surface) => SURFACE_LABELS[s].toLowerCase();
  if (!top) return side ? `Your miss is ${side}` : "Dial in your miss in My bag";
  if (good >= 55 || (top.surface === "green" && top.pct >= 45)) {
    const land = name(GOOD.find((s) => plan.mix.some((m) => m.surface === s && m.pct >= 20)) ?? top.surface);
    const rough = plan.mix.find((m) => m.surface === "rough" && m.pct >= 15);
    if (trouble) return `Mostly ${land} · miss finds ${name(trouble.surface)} (${trouble.pct}%)`;
    if (rough && land === "green") return `Mostly green · miss finds rough (${rough.pct}%)`;
    if (side && top.pct < 85) return `Mostly ${land} · miss tends ${side}`;
    return `Mostly ${land} (${top.pct}%)`;
  }
  if (trouble && trouble.pct >= 18) return `Likely ${name(trouble.surface)} (${trouble.pct}%)`;
  const second = plan.mix[1];
  return second ? `${name(top.surface)} ${top.pct}% · ${name(second.surface)} ${second.pct}%` : `${name(top.surface)} ${top.pct}%`;
}

/** The enabled club whose carry is closest to a plays-like distance; drivers only off the tee. */
export function clubFor(bag: Bag, playsYd: number, fromTee: boolean): number {
  return suggestClub(bag, playsYd, fromTee, 3);
}

/** The enabled club whose carry is closest to the distance, preferring the longest club off a par 4/5 tee. */
export function suggestClub(bag: Bag, toGreenYd: number, fromTee: boolean, par: number | null): number {
  const all = bag.clubs.map((c, i) => ({ c, i })).filter(({ c }) => c.enabled);
  if (!all.length) return 0;
  const offDeck = all.filter(({ c }) => !/driver/i.test(c.name));
  const clubs = fromTee || !offDeck.length ? all : offDeck;
  if (fromTee && (par ?? 4) >= 4) {
    const fitting = clubs.filter(({ c }) => c.carry <= toGreenYd - 30);
    const pick = fitting.length ? fitting : clubs;
    return pick.reduce((a, b) => (b.c.carry > a.c.carry ? b : a)).i;
  }
  return clubs.reduce((a, b) => (Math.abs(b.c.carry - toGreenYd) < Math.abs(a.c.carry - toGreenYd) ? b : a)).i;
}

/**
 * Pick a club for the shot ahead: close to the plays-like number, then the one whose
 * misses stay on fairway/green and out of water, trees and OB.
 */
export function adviseClub(
  course: Course,
  hole: Hole,
  tee: Tee,
  grid: HeightGrid,
  ball: XY,
  bag: Bag,
  miss: Miss,
  target: XY | null,
  fromTee: boolean,
): { index: number; plan: ShotPlan } {
  const goal = target ? playsLikeYd(grid, ball, target) : playsLikeYd(grid, ball, hole.green.middle);
  const seed = suggestClub(bag, goal, fromTee, hole.par);
  const all = bag.clubs.map((c, i) => ({ c, i })).filter(({ c }) => c.enabled);
  const offDeck = all.filter(({ c }) => !/driver/i.test(c.name));
  const pool = fromTee || !offDeck.length ? all : offDeck;
  // Tee shot on a long hole: try the longest few that still leave a wedge; else try clubs near the goal.
  const candidates = (() => {
    if (fromTee && (hole.par ?? 4) >= 4 && !target) {
      const fitting = pool.filter(({ c }) => c.carry <= goal - 25);
      const base = (fitting.length ? fitting : pool).sort((a, b) => b.c.carry - a.c.carry).slice(0, 4);
      return base;
    }
    return pool
      .map((x) => ({ ...x, d: Math.abs(x.c.carry - goal) }))
      .filter((x) => x.d <= 25 || x.i === seed)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
  })();
  const scored = candidates.map(({ c, i }) => {
    const plan = planShot(course, hole, tee, grid, ball, c, miss, target, 120);
    return { index: i, plan, carry: c.carry, safety: safetyScore(plan.mix) };
  });
  let best = scored[0] ?? {
    index: seed,
    plan: planShot(course, hole, tee, grid, ball, bag.clubs[seed], miss, target, 120),
    carry: bag.clubs[seed].carry,
    safety: 0,
  };
  if (fromTee && !target && (hole.par ?? 4) >= 4) {
    // Off the tee, take the longest club that isn't clearly more reckless than a shorter one.
    const safest = Math.max(...scored.map((s) => s.safety));
    best = scored.filter((s) => s.safety >= safest - 18).sort((a, b) => b.carry - a.carry)[0] ?? best;
  } else {
    for (const s of scored) {
      const fit = 1 - Math.min(Math.abs(s.carry - goal) / 30, 1);
      const score = s.safety + fit * 30;
      const bestFit = 1 - Math.min(Math.abs(best.carry - goal) / 30, 1);
      if (score > best.safety + bestFit * 30) best = s;
    }
  }
  // Full sample count for the winner so the scatter matches the advice.
  const plan = planShot(course, hole, tee, grid, ball, bag.clubs[best.index], miss, target);
  return { index: best.index, plan };
}
