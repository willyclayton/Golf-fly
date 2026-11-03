// Builds the 3D scene for one hole: a terrain mesh painted with surfaces, plus overlays.

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Course, Feature, Geometry, HeightGrid, Hole, Tee, XY } from "./course";

const SURFACE_COLORS: Record<string, string> = {
  outside: "#b9b8a3",
  rough: "#6f9b4e",
  trees: "#3f6b35",
  fairway: "#8cc263",
  tee: "#9fd07a",
  green: "#b4e08a",
  bunker: "#eadcb0",
  water: "#5d9fd1",
  cartpath: "#d8d4cb",
  clubhouse: "#c9a98c",
  tree: "#2f5a2a",
};

// Painted in this order, so later kinds cover earlier ones.
const POLYGON_ORDER = ["trees", "fairway", "tee", "green", "bunker", "water", "clubhouse"];

const CONTOUR_INTERVAL_M = 0.5;
const TEXTURE_PX_PER_CELL = 3;
const MAX_TEXTURE_PX = 4096;

export interface HoleScene {
  group: THREE.Group;
  terrain: THREE.Mesh;
  overlays: THREE.Group;
  /** Scene position of a local point on the ground, at the current exaggeration. */
  ground(p: XY, lift?: number): THREE.Vector3;
  setExaggeration(exag: number): void;
  setTee(tee: Tee): void;
  setResolution(width: number, height: number): void;
  dispose(): void;
}

function paintSurfaces(grid: HeightGrid, course: Course): HTMLCanvasElement {
  const { cols, rows, cell_m } = grid.spec;
  const scale = Math.min(TEXTURE_PX_PER_CELL, MAX_TEXTURE_PX / cols, MAX_TEXTURE_PX / rows);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cols * scale);
  canvas.height = Math.ceil(rows * scale);
  const ctx = canvas.getContext("2d")!;
  const px = scale / cell_m;
  // Canvas pixels are (u, v) in metres times px: u runs along the hole, v to its left.
  ctx.setTransform(
    grid.cos * px,
    -grid.sin * px,
    grid.sin * px,
    grid.cos * px,
    -(grid.spec.origin[0] * grid.cos + grid.spec.origin[1] * grid.sin) * px,
    (grid.spec.origin[0] * grid.sin - grid.spec.origin[1] * grid.cos) * px,
  );

  const tracePolygon = (rings: XY[][]) => {
    for (const ring of rings) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
  };
  const fillGeometry = (g: Geometry, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    if (g.type === "Polygon") tracePolygon(g.coordinates);
    else if (g.type === "MultiPolygon") g.coordinates.forEach(tracePolygon);
    else return;
    ctx.fill("evenodd");
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = SURFACE_COLORS.outside;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  fillGeometry(course.outline, SURFACE_COLORS.rough);

  const byKind = new Map<string, Feature[]>();
  for (const f of course.features) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  for (const kind of POLYGON_ORDER) {
    for (const f of byKind.get(kind) ?? []) fillGeometry(f.geometry, SURFACE_COLORS[kind]);
  }

  ctx.strokeStyle = SURFACE_COLORS.cartpath;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  for (const f of byKind.get("cartpath") ?? []) {
    if (f.geometry.type !== "LineString") continue;
    ctx.beginPath();
    f.geometry.coordinates.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  ctx.fillStyle = SURFACE_COLORS.tree;
  for (const f of byKind.get("tree") ?? []) {
    if (f.geometry.type !== "Point") continue;
    ctx.beginPath();
    ctx.arc(f.geometry.coordinates[0], f.geometry.coordinates[1], 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function terrainMaterial(texture: THREE.Texture): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  // Thin contour lines drawn in the shader from each fragment's true (unexaggerated) height.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.contourInterval = { value: CONTOUR_INTERVAL_M };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float heightM;\nvarying float vHeightM;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeightM = heightM;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float contourInterval;\nvarying float vHeightM;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float ch = vHeightM / contourInterval;
        float cw = fwidth(ch);
        float cl = 1.0 - smoothstep(0.0, cw * 1.2, abs(fract(ch + 0.5) - 0.5));
        diffuseColor.rgb *= 1.0 - 0.28 * cl;`,
      );
  };
  return mat;
}

function terrainMesh(grid: HeightGrid, texture: THREE.Texture): THREE.Mesh {
  const { cols, rows, cell_m } = grid.spec;
  const n = rows * cols;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const heightM = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const [x, y] = grid.toLocal((c + 0.5) * cell_m, (r + 0.5) * cell_m);
      const h = Number.isFinite(grid.values[i]) ? grid.values[i] : grid.min;
      pos.set([x, h - grid.min, -y], i * 3);
      uv.set([(c + 0.5) / cols, (r + 0.5) / rows], i * 2);
      heightM[i] = h;
    }
  }
  const index: number[] = [];
  const ok = (i: number) => Number.isFinite(grid.values[i]);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (ok(a) && ok(b) && ok(d) && ok(e)) index.push(a, b, d, b, e, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setAttribute("heightM", new THREE.BufferAttribute(heightM, 1));
  geom.setIndex(index);
  geom.computeVertexNormals();
  return new THREE.Mesh(geom, terrainMaterial(texture));
}

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = `label ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function centroid(g: Geometry): XY | null {
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const sx = ring.reduce((s, p) => s + p[0], 0);
  const sy = ring.reduce((s, p) => s + p[1], 0);
  return [sx / ring.length, sy / ring.length];
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
  const texture = new THREE.CanvasTexture(paintSurfaces(grid, course));
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const terrain = terrainMesh(grid, texture);
  const overlays = new THREE.Group();
  const group = new THREE.Group();
  group.add(terrain, overlays);

  const features = new Map(course.features.map((f) => [f.id, f]));
  let exag = initialExag;
  let tee = initialTee;
  const ground = (p: XY, lift = 0) => new THREE.Vector3(p[0], (grid.heightAt(p[0], p[1]) - grid.min) * exag + lift, -p[1]);

  const lineMats: LineMaterial[] = [];
  const drapedLine = (path: XY[], color: number, width: number, dashed = false) => {
    const pts = densify(path).flatMap((p) => ground(p, 0.6).toArray());
    const geom = new LineGeometry();
    geom.setPositions(pts);
    const mat = new LineMaterial({ color, linewidth: width, dashed, dashSize: 4, gapSize: 3, resolution });
    lineMats.push(mat);
    const line = new Line2(geom, mat);
    line.computeLineDistances();
    return line;
  };

  const marker = (p: XY, color: number, radius: number) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    m.renderOrder = 10;
    m.position.copy(ground(p, radius));
    return m;
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
  };

  const rebuildOverlays = () => {
    clearOverlays();
    overlays.add(drapedLine(tee.path, 0xffffff, 3));

    for (const t of hole.tees) {
      const active = t.id === tee.id;
      overlays.add(marker(t.point, active ? 0xffffff : 0x8a8a8a, active ? 0.9 : 0.6));
    }
    const teeLabel = label(`${Math.round(tee.length_yd)} yd`, "tee");
    teeLabel.position.copy(ground(tee.point, 6));
    overlays.add(teeLabel);

    const pin = hole.green.pins[0] ?? hole.green.middle;
    const flagBase = ground(pin);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    pole.position.copy(flagBase).add(new THREE.Vector3(0, 3.5, 0));
    const flag = new THREE.Mesh(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1.6, 0), new THREE.Vector3(2.6, -0.8, 0)]),
      new THREE.MeshBasicMaterial({ color: 0xe23b3b, side: THREE.DoubleSide }),
    );
    flag.position.copy(flagBase).add(new THREE.Vector3(0, 7, 0));
    overlays.add(pole, flag);

    for (const m of hole.marks) {
      if (m.yd >= tee.length_yd) continue;
      overlays.add(marker(m.point, 0xffd23f, 0.6));
      const l = label(`${m.yd}`, "mark");
      l.position.copy(ground(m.point, 3));
      overlays.add(l);
    }

    for (const hz of tee.hazards) {
      const f = features.get(hz.feature);
      const c = f && centroid(f.geometry);
      if (!c) continue;
      const text = hz.greenside ? `${hz.kind} ${Math.round(hz.reach_yd)}` : `${Math.round(hz.reach_yd)} / ${Math.round(hz.carry_yd)}`;
      const l = label(text, `hazard ${hz.kind}`);
      l.position.copy(ground(c, 2.5));
      overlays.add(l);
    }
  };

  const setExaggeration = (value: number) => {
    exag = value;
    terrain.scale.y = value;
    rebuildOverlays();
  };
  setExaggeration(initialExag);

  return {
    group,
    terrain,
    overlays,
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
      terrain.geometry.dispose();
      (terrain.material as THREE.Material).dispose();
      texture.dispose();
    },
  };
}
