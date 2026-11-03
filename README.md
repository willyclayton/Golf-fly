# Golf Fly: a 3D yardage book

A mobile web app that turns Chicago-area public courses into a rotatable 3D yardage book, a live GPS book on the course, and a printable pocket booklet. The full spec is in [docs/spec.md](docs/spec.md).

## Status

The spec builds in four phases, starting with the data, because coverage decides whether the rest is worth building. This repo is in **phase 1: the course data pipeline**.

| Part | State |
| --- | --- |
| Course pipeline: find, audit, elevation, terrain grids, yardages, package | Built, tested on a synthetic course |
| Regional coverage survey (which Chicago courses OSM can build) | Built; run it from Actions |
| 3D hole view, greens, overlays, on-course mode, booklet, accounts | Not started |

## Course pipeline

`pipeline/` is a Python package, `golffly`. It turns an OpenStreetMap golf course plus bare-earth lidar into a static course package. The app never calls map or elevation services itself; it only reads packages.

Steps (spec, "Course data pipeline"):

1. Find the course: the OSM `leisure=golf_course` outline, by OSM id or name.
2. Pull holes, tees, greens, fairways, bunkers, water, rough, trees and paths from Overpass.
3. Audit: the course passes only if all 18 holes have a hole line, a green polygon and at least one tee. Failing courses get a report and no package.
4. Pull the bare-earth DTM for the course plus 50 m: ISGS Cook (QL1) or DuPage (QL2+) lidar where it covers the whole course, USGS 3DEP otherwise.
5. Build terrain: a 1 m grid along each hole corridor, and a 0.25 m grid for each green plus a 10 m apron, smoothed over about 1 m.
6. Compute yardages per tee: length along the line of play, carry and reach for bunkers and water within 40 yd of it, green front/middle/back, depth and width, 100/150/200 marks, and tee-to-green elevation change.
7. Write the package: `course.json` plus compressed height grids, stamped with the OSM date and the lidar source and year.

### Run it on GitHub (recommended)

Actions → **Course pipeline** → Run workflow:

- **survey**: audits every OSM golf course within 75 km of the Loop. The report shows in the run's summary: buildable courses, near misses (1-3 holes to fix in OSM), multi-course facilities, partial and 9-hole layouts. The full JSON is in the run's artifact.
- **audit**: the same checks for the courses you list (`way/123456`, `relation/456`, or a name; separate several with `;`).
- **build**: builds packages for courses that pass the audit. Download them from the run's artifact. If `courses/scorecards/<slug>.yaml` exists, the build report compares hole lengths with the printed scorecard.

### Run it locally

```sh
cd pipeline
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest                                       # offline tests on a synthetic course
python -m golffly survey                     # needs internet access
python -m golffly audit "George W. Dunne National"
python -m golffly build way/123456 --out ../out/courses
```

HTTP responses are cached in `pipeline/.cache/http`; pass `--no-cache` for fresh data.

### Course package

```
<slug>/course.json           course, holes, tees, tee sets, features, yardages
<slug>/holes/NN-terrain.bin  1 m hole corridor heights
<slug>/holes/NN-green.bin    0.25 m smoothed green heights
```

- Geometry is in metres in a local transverse Mercator frame centred on the course (`frame.proj4` in `course.json`), so the app can project GPS fixes into the same frame.
- Yardages are in yards and elevation changes in feet, as on a yardage book page.
- Each grid is rotated to its hole: the u axis points down the line of play. `pipeline/golffly/terrain.py` documents the grid layout and the `u16-delta-shuffle-gzip` height encoding.
- Tees tagged with a colour or name in OSM form named tee sets. Otherwise tees are ranked by length and labelled Back, Middle and Forward.
- Each green carries a confidence badge from its lidar source (High: Cook QL1, Medium: DuPage QL2+, Low: 3DEP QL2) and the lidar year.

## Data and credits

- Map data © OpenStreetMap contributors, under the ODbL. Credit it on screen and in print.
- Elevation: Illinois State Geological Survey county lidar, and the U.S. Geological Survey 3D Elevation Program.
