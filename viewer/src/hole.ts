// Builds the 3D scene for one hole: painted terrain, trees, and decluttered overlays.

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Course, Feature, Geometry, HeightGrid, Hole, Tee, XY } from "./course";

export const PALETTE = {
  outside: "#6f8a58",
  surround: "#5d7849",
  rough: "#4f7a3a",
  collar: "#629645",
  fairway: "#6fa34a",
  fringe: "#7fae52",
  green: "#86bc5c",
  tee: "#79ae50",
  teeRim: "#5e8e3e",
  bunker: "#e6d7ae",
  bunkerLip: "#c9b88a",
  water: "#3d6f8e",
  waterEdge: "#5e93a8",
  shore: "#2f5566",
  treeFloor: "#3a5a2e",
  canopyDark: "#2e4f27",
  canopyLight: "#3f6631",
  cartpath: "#cfcac0",
  clubhouse: "#b8a58f",
};

const TEXTURE_PX_PER_M = 8;
const MAX_TEXTURE_PX = 4096;
const EDGE_FADE_M = 30;
const EDGE_TAPER_M = 25;
const STRIPE_M = 8;
const TREE_SPACING_M = Math.sqrt(60);
const MAX_TREES = 1500;
const SUN_ELEVATION = THREE.MathUtils.degToRad(35);

export interface SceneLabel {
  object: CSS2DObject;
  /** Lower is more important; labels lose collisions to more important ones. */
  priority: number;
}

export interface HoleScene {
  group: THREE.Group;
  labels: SceneLabel[];
  /** Unit vector pointing at the sun, for the directional light. */
  sunDirection: THREE.Vector3;
  /** Scene position of a local point on the ground, at the current exaggeration. */
  ground(p: XY, lift?: number): THREE.Vector3;
  setExaggeration(exag: number): void;
  setTee(tee: Tee): void;
  setResolution(width: number, height: number): void;
  dispose(): void;
}

interface Tree {
  x: number;
  y: number;
  height: number;
  radius: number;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function insidePolygon(poly: XY[][], x: number, y: number): boolean {
  return insideRing(poly[0], x, y) && !poly.slice(1).some((hole) => insideRing(hole, x, y));
}

function inGrid(grid: HeightGrid, x: number, y: number, margin = 0): boolean {
  const [u, v] = grid.toUV(x, y);
  const { cols, rows, cell_m } = grid.spec;
  return u >= margin && v >= margin && u <= cols * cell_m - margin && v <= rows * cell_m - margin;
}

function plantTrees(grid: HeightGrid, features: Feature[], seed: number): Tree[] {
  const rand = mulberry32(seed);
  const trees: Tree[] = [];
  const add = (x: number, y: number) => {
    const height = 9 + rand() * 7;
    trees.push({ x, y, height, radius: height * 0.35 });
  };
  for (const f of features) {
    if (f.kind === "tree" && f.geometry.type === "Point") {
      const [x, y] = f.geometry.coordinates;
      if (inGrid(grid, x, y, 2)) add(x, y);
    }
  }
  for (const f of features) {
    if (f.kind !== "trees") continue;
    for (const poly of rings(f.geometry)) {
      const xs = poly[0].map((p) => p[0]);
      const ys = poly[0].map((p) => p[1]);
      for (let x = Math.min(...xs); x < Math.max(...xs); x += TREE_SPACING_M) {
        for (let y = Math.min(...ys); y < Math.max(...ys); y += TREE_SPACING_M) {
          const jx = x + (rand() - 0.5) * TREE_SPACING_M * 0.8;
          const jy = y + (rand() - 0.5) * TREE_SPACING_M * 0.8;
          if (trees.length >= MAX_TREES) return trees;
          if (inGrid(grid, jx, jy, 2) && insidePolygon(poly, jx, jy)) add(jx, jy);
        }
      }
    }
  }
  return trees;
}

function paintSurfaces(grid: HeightGrid, course: Course, trees: Tree[], shadow: XY): HTMLCanvasElement {
  const { cols, rows, cell_m } = grid.spec;
  const scale = Math.min(TEXTURE_PX_PER_M * cell_m, MAX_TEXTURE_PX / cols, MAX_TEXTURE_PX / rows);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cols * scale);
  canvas.height = Math.ceil(rows * scale);
  const ctx = canvas.getContext("2d")!;
  const px = scale / cell_m;
  const [ox, oy] = grid.spec.origin;
  // Canvas pixels are (u, v) in metres times px: u runs down the hole, v to its left.
  const local = () =>
    ctx.setTransform(
      grid.cos * px,
      -grid.sin * px,
      grid.sin * px,
      grid.cos * px,
      -(ox * grid.cos + oy * grid.sin) * px,
      (ox * grid.sin - oy * grid.cos) * px,
    );
  const pixels = () => ctx.setTransform(1, 0, 0, 1, 0, 0);

  const byKind = new Map<string, Feature[]>();
  for (const f of course.features) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  const polys = (kind: string) => (byKind.get(kind) ?? []).flatMap((f) => rings(f.geometry));
  const trace = (poly: XY[][]) => {
    ctx.beginPath();
    for (const ring of poly) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
  };
  const fill = (poly: XY[][], color: string) => {
    trace(poly);
    ctx.fillStyle = color;
    ctx.fill("evenodd");
  };
  const stroke = (poly: XY[][], color: string, width: number) => {
    trace(poly);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.stroke();
  };
  /** Stroke only the inside half of the outline: an inner band of the given width. */
  const innerBand = (poly: XY[][], color: string, width: number) => {
    ctx.save();
    trace(poly);
    ctx.clip("evenodd");
    stroke(poly, color, width * 2);
    ctx.restore();
  };

  pixels();
  ctx.fillStyle = PALETTE.outside;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  local();
  for (const poly of rings(course.outline)) fill(poly, PALETTE.rough);
  for (const poly of polys("trees")) fill(poly, PALETTE.treeFloor);

  const fairways = polys("fairway");
  for (const poly of fairways) stroke(poly, PALETTE.collar, 2);
  for (const poly of fairways) fill(poly, PALETTE.fairway);
  // Mowing bands across the line of play.
  for (const poly of fairways) {
    ctx.save();
    trace(poly);
    ctx.clip("evenodd");
    pixels();
    for (let k = 0, x = 0; x < canvas.width; k++, x += STRIPE_M * px) {
      ctx.fillStyle = k % 2 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.045)";
      ctx.fillRect(x, 0, STRIPE_M * px, canvas.height);
    }
    ctx.restore();
    local();
  }

  for (const poly of polys("tee")) {
    fill(poly, PALETTE.tee);
    innerBand(poly, PALETTE.teeRim, 0.4);
  }
  const greens = polys("green");
  for (const poly of greens) stroke(poly, PALETTE.fringe, 1.6);
  for (const poly of greens) fill(poly, PALETTE.green);
  for (const poly of polys("bunker")) {
    fill(poly, PALETTE.bunker);
    innerBand(poly, PALETTE.bunkerLip, 0.6);
  }
  for (const poly of polys("water")) {
    fill(poly, PALETTE.waterEdge);
    ctx.save();
    trace(poly);
    ctx.clip("evenodd");
    // Blurring the deep fill inside the clip leaves a lighter 2-3 m shallow edge.
    ctx.filter = `blur(${2 * px}px)`;
    fill(poly, PALETTE.water);
    ctx.filter = "none";
    ctx.restore();
    stroke(poly, PALETTE.shore, 0.4);
  }
  for (const poly of polys("clubhouse")) fill(poly, PALETTE.clubhouse);

  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = PALETTE.cartpath;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const f of byKind.get("cartpath") ?? []) {
    if (f.geometry.type !== "LineString") continue;
    ctx.beginPath();
    f.geometry.coordinates.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Baked soft shadows under each tree, cast away from the sun.
  ctx.fillStyle = "rgba(18, 32, 14, 0.32)";
  for (const t of trees) {
    ctx.beginPath();
    ctx.ellipse(t.x + shadow[0] * t.height * 0.6, t.y + shadow[1] * t.height * 0.6, t.radius * 1.1, t.radius * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fade the grid border into the surrounding ground.
  pixels();
  const fade = EDGE_FADE_M * px;
  const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, PALETTE.surround);
    g.addColorStop(1, "rgba(93,120,73,0)");
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };
  const W = canvas.width;
  const H = canvas.height;
  edge(0, 0, fade, 0, 0, 0, fade, H);
  edge(W, 0, W - fade, 0, W - fade, 0, fade, H);
  edge(0, 0, 0, fade, 0, 0, W, fade);
  edge(0, H, 0, H - fade, 0, H - fade, W, fade);
  return canvas;
}

const NOISE_GLSL = `
float gfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gfHash(i), gfHash(i + vec2(1.0, 0.0)), u.x), mix(gfHash(i + vec2(0.0, 1.0)), gfHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float gfContour(float h, float interval) {
  float c = h / interval;
  return 1.0 - smoothstep(0.0, fwidth(c) * 1.2, abs(fract(c + 0.5) - 0.5));
}`;

function terrainMaterial(texture: THREE.Texture, greenCenter: THREE.Vector2, greenRadius: number): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.greenCenter = { value: greenCenter };
    shader.uniforms.greenRadius = { value: greenRadius };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float heightM;\nvarying float vHeightM;\nvarying vec2 vWorldXZ;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvHeightM = heightM;\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec2 greenCenter;
        uniform float greenRadius;
        varying float vHeightM;
        varying vec2 vWorldXZ;
        ${NOISE_GLSL}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        // Dense contours on and around the green; faint, nearby-only contours elsewhere.
        float nearGreen = 1.0 - smoothstep(greenRadius, greenRadius + 10.0, distance(vWorldXZ, greenCenter));
        float camFade = 1.0 - smoothstep(110.0, 150.0, distance(vWorldXZ, cameraPosition.xz));
        float dark = mix(0.06 * camFade * gfContour(vHeightM, 1.0), 0.18 * gfContour(vHeightM, 0.25), nearGreen);
        float grain = gfNoise(vWorldXZ / 25.0) * 0.6 + gfNoise(vWorldXZ / 6.0) * 0.4;
        diffuseColor.rgb *= (1.0 + (grain - 0.5) * 0.08) * (1.0 - dark);`,
      );
  };
  return mat;
}

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = `label ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function centroid(g: Geometry): XY | null {
  const ring = rings(g)[0]?.[0];
  if (!ring?.length) return null;
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
}

/** Points every ~2 m along a polyline, so a draped line follows the ground. */
function densify(path: XY[], step = 2): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(path[path.length - 1]);
  return out;
}

export function buildHoleScene(
  course: Course,
  hole: Hole,
  grid: HeightGrid,
  resolution: THREE.Vector2,
  initialTee: Tee,
  initialExag: number,
): HoleScene {
  const { cols, rows, cell_m } = grid.spec;
  const widthM = cols * cell_m;
  const heightM = rows * cell_m;
  const taperAt = (u: number, v: number) =>
    THREE.MathUtils.smoothstep(Math.min(u, v, widthM - u, heightM - v), 0, EDGE_TAPER_M);
  const relHeight = (x: number, y: number) => {
    const [u, v] = grid.toUV(x, y);
    return (grid.heightAt(x, y) - grid.min) * taperAt(u, v);
  };

  // Sun behind the golfer's left shoulder, looking from the back tee to the green.
  const back = hole.tees.reduce((a, b) => (b.length_yd > a.length_yd ? b : a));
  const axis = new THREE.Vector3(hole.green.middle[0] - back.point[0], 0, -(hole.green.middle[1] - back.point[1])).normalize();
  const right = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0));
  const flat = axis.clone().negate().sub(right).normalize();
  const sunDirection = flat.multiplyScalar(Math.cos(SUN_ELEVATION)).setY(Math.sin(SUN_ELEVATION)).normalize();
  const shadow: XY = [-sunDirection.x, sunDirection.z];
  const shadowLen = Math.hypot(...shadow);
  shadow[0] /= shadowLen;
  shadow[1] /= shadowLen;

  const trees = plantTrees(grid, course.features, hole.number * 7919);
  const texture = new THREE.CanvasTexture(paintSurfaces(grid, course, trees, shadow));
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  // --- terrain mesh ------------------------------------------------------
  const n = rows * cols;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const realHeight = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const u = (c + 0.5) * cell_m;
      const v = (r + 0.5) * cell_m;
      const [x, y] = grid.toLocal(u, v);
      const h = Number.isFinite(grid.values[i]) ? grid.values[i] : grid.min;
      pos.set([x, (h - grid.min) * taperAt(u, v), -y], i * 3);
      uv.set([(c + 0.5) / cols, (r + 0.5) / rows], i * 2);
      realHeight[i] = h;
    }
  }
  const index: number[] = [];
  const ok = (i: number) => Number.isFinite(grid.values[i]);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      if (ok(a) && ok(a + 1) && ok(a + cols) && ok(a + cols + 1)) index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setAttribute("heightM", new THREE.BufferAttribute(realHeight, 1));
  geom.setIndex(index);
  geom.computeVertexNormals();
  const greenCenter = new THREE.Vector2(hole.green.middle[0], -hole.green.middle[1]);
  const greenRadius = (Math.max(hole.green.depth_yd, hole.green.width_yd) * 0.9144) / 2;
  const terrain = new THREE.Mesh(geom, terrainMaterial(texture, greenCenter, greenRadius));

  const [cx, cy] = grid.toLocal(widthM / 2, heightM / 2);
  const skirt = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: PALETTE.surround }),
  );
  skirt.position.set(cx, -0.05, -cy);

  // --- trees -------------------------------------------------------------
  const canopies = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    Math.max(1, trees.length),
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.18, 0.28, 1, 5),
    new THREE.MeshLambertMaterial({ color: "#4a3a2a" }),
    Math.max(1, trees.length),
  );
  canopies.count = trunks.count = trees.length;
  const rand = mulberry32(hole.number);
  const dark = new THREE.Color(PALETTE.canopyDark);
  const light = new THREE.Color(PALETTE.canopyLight);
  trees.forEach((_, i) => canopies.setColorAt(i, dark.clone().lerp(light, rand()).multiplyScalar(0.92 + rand() * 0.16)));

  const overlays = new THREE.Group();
  const group = new THREE.Group();
  group.add(skirt, terrain, canopies, trunks, overlays);

  const features = new Map(course.features.map((f) => [f.id, f]));
  let exag = initialExag;
  let tee = initialTee;
  const labels: SceneLabel[] = [];
  const lineMats: LineMaterial[] = [];
  const ground = (p: XY, lift = 0) => new THREE.Vector3(p[0], relHeight(p[0], p[1]) * exag + lift, -p[1]);

  const placeTrees = () => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    trees.forEach((t, i) => {
      const base = relHeight(t.x, t.y) * exag;
      m.compose(new THREE.Vector3(t.x, base + t.height * 0.62, -t.y), q, new THREE.Vector3(t.radius, t.height * 0.42, t.radius));
      canopies.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, base + t.height * 0.2, -t.y), q, new THREE.Vector3(1, t.height * 0.4, 1));
      trunks.setMatrixAt(i, m);
    });
    canopies.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    canopies.computeBoundingSphere();
    trunks.computeBoundingSphere();
  };

  const line = (pts: THREE.Vector3[], color: number, width: number, opacity: number) => {
    const g = new LineGeometry();
    g.setPositions(pts.flatMap((p) => p.toArray()));
    const mat = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, resolution });
    lineMats.push(mat);
    return new Line2(g, mat);
  };

  const addLabel = (text: string, cls: string, at: THREE.Vector3, priority: number) => {
    const l = label(text, cls);
    l.position.copy(at);
    overlays.add(l);
    labels.push({ object: l, priority });
  };

  const clearOverlays = () => {
    for (const child of [...overlays.children]) {
      overlays.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        if (o instanceof THREE.Mesh || o instanceof Line2) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    lineMats.length = 0;
    labels.length = 0;
  };

  const rebuildOverlays = () => {
    clearOverlays();
    const path = densify(tee.path).map((p) => ground(p, 0.5));
    const halo = line(path, 0x2c4a2a, 4.5, 1);
    (halo.material as LineMaterial).depthWrite = false;
    const play = line(path, 0xf4f6f2, 2, 1);
    play.renderOrder = 2;
    overlays.add(halo, play);

    const teeDot = label("", "tee-dot");
    teeDot.position.copy(ground(tee.point, 0.3));
    overlays.add(teeDot);

    const pin = hole.green.pins[0] ?? hole.green.middle;
    const flagBase = ground(pin);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    pole.position.copy(flagBase).add(new THREE.Vector3(0, 3, 0));
    const flag = new THREE.Mesh(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1.4, 0), new THREE.Vector3(2.2, -0.7, 0)]),
      new THREE.MeshBasicMaterial({ color: 0xe8413b, side: THREE.DoubleSide }),
    );
    flag.position.copy(flagBase).add(new THREE.Vector3(0, 6, 0));
    overlays.add(pole, flag);

    // Distance marks: a short tick across the line of play and a bare number.
    for (const m of hole.marks) {
      if (m.yd >= tee.length_yd) continue;
      const [mx, my] = m.point;
      const across: XY = [-axis.z, -axis.x];
      const a = ground([mx - across[0] * 3, my - across[1] * 3], 0.6);
      const b = ground([mx + across[0] * 3, my + across[1] * 3], 0.6);
      overlays.add(line([a, b], 0xffffff, 2.5, 0.95));
      addLabel(`${m.yd}`, "mark", ground(m.point, 2.5), 1);
    }

    // At most four hazards: those around the landing zone first, then greenside ones.
    const ranked = tee.hazards
      .filter((h) => h.reach_yd <= tee.length_yd)
      .map((h) => {
        const landing = !h.greenside && (hole.par ?? 4) >= 4 && h.carry_yd >= 150 && h.reach_yd <= 300;
        return { h, score: landing ? 0 : h.greenside ? 2 : 3 };
      })
      .sort((a, b) => a.score - b.score || a.h.reach_yd - b.h.reach_yd)
      .slice(0, 4);
    for (const { h, score } of ranked) {
      const f = features.get(h.feature);
      const c = f && centroid(f.geometry);
      // Greenside carries run to the green itself, so show how far it is to reach them instead.
      if (c) addLabel(`${Math.round(h.greenside ? h.reach_yd : h.carry_yd)}`, `hazard ${h.kind}`, ground(c, 2), score);
    }
  };

  const setExaggeration = (value: number) => {
    exag = value;
    terrain.scale.y = value;
    placeTrees();
    rebuildOverlays();
  };
  setExaggeration(initialExag);

  return {
    group,
    labels,
    sunDirection,
    ground,
    setExaggeration,
    setTee(t: Tee) {
      tee = t;
      rebuildOverlays();
    },
    setResolution(width: number, height: number) {
      resolution.set(width, height);
      for (const m of lineMats) m.resolution.set(width, height);
    },
    dispose() {
      clearOverlays();
      for (const mesh of [terrain, skirt, canopies, trunks]) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      texture.dispose();
    },
  };
}
