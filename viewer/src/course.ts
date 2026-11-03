// Types and loaders for golf-fly/course@1 packages (see pipeline/golffly/build.py and terrain.py).

export type XY = [number, number];

export interface GridSpec {
  origin: XY;
  rotation_deg: number;
  cell_m: number;
  cols: number;
  rows: number;
}

export interface HeightFile {
  file: string;
  grid: GridSpec;
  encoding: string;
  base_m: number;
  step_m: number;
  nodata: number;
  min_m: number;
  max_m: number;
}

export interface Hazard {
  feature: string;
  kind: string;
  reach_yd: number;
  carry_yd: number;
  side: string;
  offset_yd: number;
  greenside: boolean;
}

export interface Tee {
  id: string;
  labels: string[];
  sets: string[];
  point: XY;
  path: XY[];
  length_yd: number;
  front_yd: number;
  middle_yd: number;
  back_yd: number;
  elev_change_ft: number;
  hazards: Hazard[];
}

export interface Hole {
  number: number;
  par: number | null;
  handicap: number | null;
  line: XY[];
  green: {
    id: string;
    front: XY;
    middle: XY;
    back: XY;
    depth_yd: number;
    width_yd: number;
    confidence: string;
    lidar_year: number | null;
    pins: XY[];
  };
  tees: Tee[];
  marks: { yd: number; point: XY }[];
  terrain: HeightFile;
  green_terrain: HeightFile;
}

export type Geometry =
  | { type: "Point"; coordinates: XY }
  | { type: "LineString"; coordinates: XY[] }
  | { type: "Polygon"; coordinates: XY[][] }
  | { type: "MultiPolygon"; coordinates: XY[][][] };

export interface Feature {
  id: string;
  kind: string;
  geometry: Geometry;
}

export interface TeeSet {
  key: string;
  label: string;
  total_yd: number;
  tees: Record<string, string>;
}

export interface Course {
  name: string;
  slug: string;
  sources: {
    osm: { timestamp: string; credit: string };
    elevation: { name: string; quality: string; confidence: string; year: number | null; credit: string };
  };
  outline: Geometry;
  tee_sets: TeeSet[];
  holes: Hole[];
  features: Feature[];
}

export interface CourseIndexEntry {
  slug: string;
  name: string;
  city: string | null;
  confidence: string;
}

const base = `${import.meta.env.BASE_URL}courses/`;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function loadIndex(): Promise<{ courses: CourseIndexEntry[] }> {
  return getJson(`${base}index.json`);
}

export function loadCourse(slug: string): Promise<Course> {
  return getJson(`${base}${slug}/course.json`);
}

/** A decoded height grid; values[row * cols + col] is NaN where there is no data. */
export class HeightGrid {
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly spec: GridSpec,
    readonly values: Float32Array,
    readonly min: number,
  ) {
    const r = (spec.rotation_deg * Math.PI) / 180;
    this.cos = Math.cos(r);
    this.sin = Math.sin(r);
  }

  /** Local x, y of a (u, v) offset from the grid origin. */
  toLocal(u: number, v: number): XY {
    const [ox, oy] = this.spec.origin;
    return [ox + u * this.cos - v * this.sin, oy + u * this.sin + v * this.cos];
  }

  toUV(x: number, y: number): XY {
    const dx = x - this.spec.origin[0];
    const dy = y - this.spec.origin[1];
    return [dx * this.cos + dy * this.sin, -dx * this.sin + dy * this.cos];
  }

  /** Bilinear height at local x, y, clamped to the grid; falls back to the grid minimum. */
  heightAt(x: number, y: number): number {
    const { cols, rows, cell_m } = this.spec;
    const [u, v] = this.toUV(x, y);
    const fc = Math.min(Math.max(u / cell_m - 0.5, 0), cols - 1);
    const fr = Math.min(Math.max(v / cell_m - 0.5, 0), rows - 1);
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, cols - 1);
    const r1 = Math.min(r0 + 1, rows - 1);
    const tc = fc - c0;
    const tr = fr - r0;
    const at = (r: number, c: number) => this.values[r * cols + c];
    const h =
      (at(r0, c0) * (1 - tc) + at(r0, c1) * tc) * (1 - tr) + (at(r1, c0) * (1 - tc) + at(r1, c1) * tc) * tr;
    if (Number.isFinite(h)) return h;
    const near = at(Math.round(fr), Math.round(fc));
    return Number.isFinite(near) ? near : this.min;
  }
}

/** Decode the u16-delta-shuffle-gzip encoding written by pipeline/golffly/terrain.py. */
export async function loadHeights(slug: string, hf: HeightFile): Promise<HeightGrid> {
  if (hf.encoding !== "u16-delta-shuffle-gzip") throw new Error(`unknown height encoding ${hf.encoding}`);
  const res = await fetch(`${base}${slug}/${hf.file}`);
  if (!res.ok) throw new Error(`${hf.file}: HTTP ${res.status}`);
  const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const { rows, cols } = hf.grid;
  const n = rows * cols;
  const out = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    let q = 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      q = (q + (raw[i] | (raw[n + i] << 8))) & 0xffff;
      out[i] = q === hf.nodata ? NaN : hf.base_m + q * hf.step_m;
    }
  }
  return new HeightGrid(hf.grid, out, hf.min_m);
}
