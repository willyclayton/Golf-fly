# 3D Yardage Book — Spec

Nov 2, 2026 · @Will

## Overview

A mobile web app that turns Chicago-area public courses into a rotatable 3D yardage book, a live GPS book on the course, and a printable pocket booklet. It's for Will and a few golf buddies, and runs on free tiers only.

| Decision | Choice |
| --- | --- |
| Audience | Will + golf buddies |
| Use | Plan at home, then live GPS on the course |
| Look | Stylized classic yardage book, not photoreal |
| Coverage | Public courses within \~1 hr of Chicago, under $120 green fees |
| Platform | Mobile web app, installable to the home screen |
| Print | Pocket booklet PDF |
| Greens | Lidar slope maps with break arrows |
| Overlays | Club arcs, shot dispersion, plays-like yardage, hole notes |
| Course data | Fully automatic from OpenStreetMap + lidar, no in-app editor |
| Shot data | Tapped in the app during rounds |
| Sharing | Shared courses, personal overlays |
| Budget | Free tiers only |

Out of scope for v1: photoreal imagery, native apps, course editing, handicap posting, swing analysis.

## Course data pipeline

Each course is built once by an offline Python pipeline into a static course package. The app never calls map or elevation services live.

1. Find the course: the OSM `leisure=golf_course` area, by name or OSM id.
2. Pull golf features via the Overpass API: `golf=hole` (with ref, par, handicap), tee, green, fairway, bunker, water hazards, rough, plus trees and cart paths ([OSM golf tags](https://wiki.openstreetmap.org/wiki/Key:golf)).
3. Audit: a course passes only if all 18 holes have a hole line, a green polygon and at least one tee. Failing courses are listed, not shipped.
4. Pull bare-earth elevation (DTM) for the course area plus a 50 m buffer.
5. Build terrain: a 1 m grid for each hole corridor, 0.25 m for each green and a 10 m apron.
6. Compute yardages (below).
7. Write the package: `course.json` plus per-hole height grids, stamped with OSM and lidar dates.

OSM draws each hole as a line from the tee to about the middle of the green, with one fewer node than par ([OSM wiki](https://wiki.openstreetmap.org/Tag:golf=hole)). Doglegs come from those bend points.

| Area | Elevation source | Density |
| --- | --- | --- |
| Cook County | ISGS 2022 lidar, QL1 | 20+ points/m² ([metadata](https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_Cook_DTM_2022/ImageServer/info/metadata)) |
| DuPage County | ISGS 2022 lidar, QL2+ | QL2+ ([metadata](https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_DuPage_DTM_2022/ImageServer/info/metadata)) |
| Everywhere else | USGS 3DEP lidar, QL2 | 2+ points/m² ([report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/IL_GreenMacoupinMont_2017_C18/IL_GrnMacMont_2017/reports/IL_3_Counties_Lidar_Mapping_Report_2017.pdf)) |

Computed per tee set:

- Hole length along the hole line
- Carry to clear and distance to reach each bunker or water within 40 yd of the line of play
- Green front, middle and back along the approach line, plus green depth and width
- 100, 150 and 200 yd marks back from green center
- Elevation change from tee to green, in feet

Tees without a color or name in OSM are labeled by length: Back, Middle, Forward. The pipeline reruns on request, not on a schedule.

## 3D hole view

Each hole opens behind the tee, looking down the hole line like a yardage book page, and you can grab and rotate it.

Look:

- Flat colors per surface: fairway, rough, green, tee, sand, water, trees
- Soft hillshade and thin contour lines
- High-contrast labels that stay readable in sun

Controls:

- Drag to orbit, pinch to zoom, two-finger drag to pan
- Buttons: Tee view, Top-down, Green view, Fly the hole (a 5 to 8 s camera move from tee to green), Reset
- Vertical exaggeration slider, 1x to 3x, default 2x since Chicago terrain is subtle
- Tee set switcher
- Measure: tap two points to get distance (yd), elevation change (ft) and plays-like yardage
- Swipe through holes 1 to 18, plus a course overview map

On every hole: number, par, handicap, length per tee, hazard carry labels, 100/150/200 marks, green front/middle/back and elevation change.

Targets: a cached hole loads in under 1 s, the view runs smoothly on a recent iPhone, and a course package stays under 5 MB.

## Greens

Each green gets a slope heatmap, downhill arrows and fine contours, built from bare-earth lidar. Prove it on greens you know before trusting it.

- Grid: 0.25 m cells, smoothed over about 1 m to remove lidar noise
- Heatmap: four slope bands (flat, gentle, moderate, severe), thresholds tuned on test greens
- Arrows: about every 1.5 m, pointing downhill, length showing steepness
- Fall line: highlighted through the green's center
- Labels: front/middle/back yardages, depth and width
- Confidence badge per green: High on Cook County QL1, Medium on QL2+, Low on QL2
- Lidar year shown on every green

Why validate: the lidar spec allows about 10 cm of vertical error (RMSE) ([USGS report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/IL_MidNorth_D22/IL_MidNorth_4_D22/reports/140G0222F0045-IL_MidNorth_D22_WU_ID300137_Lidar_Mapping_Report.pdf)). That's coarse next to subtle green slopes. Greens rebuilt after the lidar flight will also read wrong.

## Personal overlays

All four overlays are per person and toggle on or off in the 3D view and in print.

**Club distance arcs**

- Club list with carry yardage; starts from numbers you type
- Once a club has 8+ tapped shots, its median replaces the typed number unless you lock it
- Arcs drawn from the tee, or from your GPS spot on the course, each labeled with its club

**Shot dispersion**

- Built from tapped shots: start, end, club and aim point
- Measured in the aim's frame: left/right miss and long/short miss
- Drawn as an ellipse holding about 68% of shots (1.5 standard deviations in 2D), centered on your average miss
- Shown once a club has 10+ shots; shots older than 12 months fade out
- Placed at the aim point, so you see whether your miss finds a bunker

**Plays-like yardage**

| Factor | Starting rule | Basis |
| --- | --- | --- |
| Elevation | About 1 yd per yd (3 ft) of drop or rise | Tour 1-to-1 rule ([Golf Digest](https://www.australiangolfdigest.com.au/pro-golfers-calculate-their-yardages-golf-course-strategy-game-plan-golf-digest/)) |
| Temperature | About 2 yd per 10°F off 75°F for driver, about 1.3 yd for a wedge, scaled by club | Andrew Rice's Trackman testing ([GOLF.com](https://golf.com/instruction/cold-weather-golf-ball-formula-yardages/)) |
| Wind | About 1% per mph into the wind, 0.5% per mph downwind | Derived from a Trackman example: a 140 yd shot loses \~20 yd into 15 mph and gains \~10 yd downwind ([Golf Digest](https://www.australiangolfdigest.com.au/pro-golfers-calculate-their-yardages-golf-course-strategy-game-plan-golf-digest/)) |

These are rules of thumb from launch-monitor tests reported by golf media, not a ball-flight model, so the constants live in settings. Weather comes from Open-Meteo for the course, cached hourly. Crosswind shows as an arrow only in v1.

**Hole notes**

- Free text per hole, private, printed in the booklet's notes box
- Optional quick tags like "Aim left edge" or "Lay up to 100"

## On-course mode

At the first tee the app becomes a GPS yardage book that works with no signal.

Before the round, "Download for offline" saves the course package, the forecast for your tee time and your overlays to the phone.

During the round:

- Course and hole detected from GPS; swipe to override
- Live numbers: green front/middle/back, carry and reach for hazards ahead, plays-like for the middle
- GPS accuracy circle as the phone reports it; yardages grey out when accuracy is worse than about 10 yd
- Club suggestion: the arc closest to the plays-like middle

Shot tapping:

1. At your ball, tap Mark and pick a club (suggested club first).
2. Optionally drag the aim pin. Default aim is green center on approaches and the next hole-line bend on tee shots.
3. The next Mark ends the previous shot. Putts and penalties are +1 buttons.
4. Finish the hole to save the score.

Shots save on the phone first and sync when signal returns. A web app can't track location in the background, so it keeps the screen awake where the browser allows and uses a high-contrast outdoor theme. GPS refreshes about every 3 s when you're still and every 1 s when you're walking.

## Printable pocket booklet

One tap exports the course as a PDF you print at home on letter paper, fold and staple into a pocket book.

- Page size: half-letter (5.5 × 8.5 in), two pages per letter sheet, double-sided; optional trim marks for a classic \~4.25 × 7 in book
- Imposition: saddle-stitch, padded to a multiple of 4 pages; print with "flip on short edge"
- Also exports a reader-order PDF for screens
- About 40 pages, which is 10 sheets

| Pages | Content |
| --- | --- |
| Cover | Course, tee set, your name, date generated, data sources |
| Inside cover | Your club carry chart and dispersion summary |
| Overview | All 18 holes on one map |
| Each hole, left page | Top-down hole diagram: hazard carries, 100/150/200 marks, elevation change, your dispersion ellipse at the default aim |
| Each hole, right page | Large green slope map, front/middle/back, depth, your notes box and blank lines |
| Back | Blank notes pages, OpenStreetMap and lidar credits |

Print rules: vector art so lines stay crisp, grayscale-safe patterns for sand and water, text no smaller than 7 pt. Plays-like numbers stay off the page because they change daily.

## Accounts and sharing

Course packages are shared by everyone; clubs, shots, dispersion and notes belong to each person.

- Sign-in by email magic link, invite-only through a group code
- A small group, roughly 2 to 10 golfers
- Anyone can request a course; once the pipeline builds it, it appears for everyone
- Row-level security: each person reads and writes only their own rows
- Later, maybe: share a round with the group, compare dispersion

## Tech stack and hosting

Everything runs on free tiers, and only weather and the personal database are live services.

&#91;embedded content: architecture · 7 parts, 2 live services\]

Course data flows left to right once per course; the phone then reads static files and syncs only your own shots and notes.

| Layer | Pick | Free-tier note |
| --- | --- | --- |
| Course pipeline | Python (requests, numpy, shapely, rasterio), run as a manual GitHub Action | Runs on demand only |
| Map data | OpenStreetMap via the Overpass API | ODbL license: credit "© OpenStreetMap contributors" on screen and in print |
| Elevation | ISGS county lidar where available, USGS 3DEP elsewhere | Public data |
| Hosting | GitHub Pages (or Cloudflare Pages) | Static files, free |
| App | Vite + TypeScript + Three.js, Workbox service worker, IndexedDB for offline | None |
| PDF | SVG pages assembled with pdf-lib in the browser | No server |
| Auth + database | Supabase free plan | 500 MB database, 50,000 monthly users, 2 projects, pauses after 7 idle days ([2026 summary](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/); third-party, check supabase.com/pricing) |
| Weather | Open-Meteo forecast API | Free for non-commercial use, no API key, CC BY 4.0 credit ([Open-Meteo](https://open-meteo.com/)) |

## Data model

Course data are static files; only personal data lives in the database.

**Course package (`course.json` + height grids)**: course id (the OSM id), name, bounds, sources (OSM date, lidar name and year), build date, and 18 holes. Each hole holds number, par, handicap, hole line, tees (label, shape, length), green, other features, computed yardages, the hole height grid, the green height grid and a green confidence level.

| Table | Key columns | Who sees it |
| --- | --- | --- |
| profiles | user\_id, display\_name, default\_tee | Self |
| clubs | user\_id, club, manual\_carry\_yd, lock\_manual | Self |
| rounds | round\_id, user\_id, course\_id, tee\_set, played\_on, weather\_snapshot | Self |
| shots | shot\_id, round\_id, hole, seq, club, start and end lat/lon, aim lat/lon, gps\_accuracy\_m | Self |
| hole\_scores | round\_id, hole, strokes, putts, penalties | Self |
| hole\_notes | user\_id, course\_id, hole, text, tags | Self |
| course\_requests | request\_id, user\_id, course\_name, status | Group |

Dispersion ellipses and median carries are computed on the phone from shots, not stored.

## Risks and open questions

The biggest risk is coverage. With fully automatic data, any course OSM hasn't mapped hole by hole can't be built, so run the audit on your course list first.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Course missing hole lines or greens in OSM | Course can't ship | Audit first; map missing holes in OSM yourself, which fixes it for everyone |
| Tee colors not tagged | Generic tee labels | Label tees by length |
| Lidar too coarse for subtle greens | Wrong break arrows | Validate on 2 to 3 known greens; confidence badge |
| Greens rebuilt after the lidar flight | Wrong slopes | Show lidar year; hide flag per green |
| Plays-like rules are rough | Numbers off by a few yards | Tunable constants; show the inputs |
| Forecast wind differs from course wind | Wind adjustment off | Label it as forecast; manual override |
| Supabase free projects pause after a week idle ([Supabase](https://supabase.com/kb/faqs/platform/free-project-pausing)) | Sign-in breaks over the winter | Daily keep-alive ping from a scheduled job; data is kept while paused |
| Web GPS only works while the app is open | Battery drain, no background tracking | Screen wake lock, GPS throttling |
| Open-Meteo is free for non-commercial use under 10,000 calls/day ([Open-Meteo](https://open-meteo.com/)) | Fine for personal use | Cache per course per hour; credit the source |

Open questions:

- [ ] Which courses go in the first batch?
- [ ] Who's in the buddy group?
- [ ] Which tee set is the default?
- [ ] Do you still log rounds in TheGrint? If so, should this track full shots or just dispersion practice rounds, to avoid double entry?
- [ ] Host it under willyclayton.com or on its own domain?

## Build plan

Build in four phases, starting with the data, because coverage decides whether the rest is worth building.

&#91;embedded content: build plan · 4 phases, 4 gates\]

Don't move to the next phase until its gate passes on a real course. Later ideas: a photoreal toggle, a course editor, and sharing rounds with the group.

## Sources

- [OpenStreetMap golf tags](https://wiki.openstreetmap.org/wiki/Key:golf) and [golf=hole](https://wiki.openstreetmap.org/Tag:golf=hole)
- [Cook County 2022 lidar metadata (ISGS)](https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_Cook_DTM_2022/ImageServer/info/metadata)
- [DuPage County 2022 lidar metadata (ISGS)](https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_DuPage_DTM_2022/ImageServer/info/metadata)
- [USGS lidar mapping report, QL2 density](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/IL_GreenMacoupinMont_2017_C18/IL_GrnMacMont_2017/reports/IL_3_Counties_Lidar_Mapping_Report_2017.pdf)
- [USGS lidar mapping report, vertical accuracy](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/IL_MidNorth_D22/IL_MidNorth_4_D22/reports/140G0222F0045-IL_MidNorth_D22_WU_ID300137_Lidar_Mapping_Report.pdf)
- [Golf Digest: how pros calculate yardages](https://www.australiangolfdigest.com.au/pro-golfers-calculate-their-yardages-golf-course-strategy-game-plan-golf-digest/) (golf media reporting Trackman data)
- [GOLF.com: cold-weather yardage formula](https://golf.com/instruction/cold-weather-golf-ball-formula-yardages/) (golf media reporting a teacher's Trackman test)
- [Open-Meteo](https://open-meteo.com/)
- [Supabase: free project pausing](https://supabase.com/kb/faqs/platform/free-project-pausing)
- [Supabase pricing 2026 summary](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) (third-party)
