// Copy built course packages into public/courses and write the index the viewer reads.
// Usage: npm run courses [-- <packages dir>]   (default: ../out/courses)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve(process.argv[2] ?? "../out/courses");
const dest = resolve("public/courses");

if (!existsSync(src)) {
  console.error(`no packages at ${src}; build some with: python -m golffly build <course> --out ../out/courses`);
  process.exit(1);
}

const courses = [];
for (const slug of readdirSync(src).sort()) {
  const json = join(src, slug, "course.json");
  if (!existsSync(json)) continue;
  const doc = JSON.parse(readFileSync(json, "utf8"));
  rmSync(join(dest, slug), { recursive: true, force: true });
  mkdirSync(join(dest, slug), { recursive: true });
  cpSync(json, join(dest, slug, "course.json"));
  cpSync(join(src, slug, "holes"), join(dest, slug, "holes"), { recursive: true });
  courses.push({
    slug,
    name: doc.name,
    city: doc.info?.city ?? null,
    elevation: doc.sources.elevation.name,
    confidence: doc.sources.elevation.confidence,
  });
}

writeFileSync(join(dest, "index.json"), JSON.stringify({ courses }, null, 2) + "\n");
console.log(`${courses.length} course(s) -> ${dest}`);
