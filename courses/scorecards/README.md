# Scorecards

Printed scorecard yardages, used to check a build (the phase 1 gate: built hole lengths should match the card). Name each file after the course's package slug, for example `george-w-dunne-national-golf-course.yaml`:

```yaml
course: George W. Dunne National Golf Course
source: https://example.com/scorecard   # where the numbers came from
par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]
tees:
  Blue: [402, 388, 175, 520, ...]        # 18 values per tee
  White: [380, 371, 160, 498, ...]
```

Scorecard tees match the build's tee sets by name, or else by the closest total yardage. The build report lists the difference on every hole.
