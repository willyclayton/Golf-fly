"""Coverage audit: a course ships only if all 18 holes have a hole line, a
green polygon and at least one tee (spec, Course data pipeline step 3)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .course import CourseData
from .geo import m_to_yd

PASS = "pass"  # buildable now
NEAR = "near"  # 1-3 holes need OSM fixes
MULTI = "multi"  # repeated or >18 hole numbers: several courses inside one outline
PARTIAL = "partial"  # some holes mapped, more gaps than a near miss
NINE = "nine"  # a 9-hole layout
OUTLINE = "outline"  # course outline only, no hole lines
STATUS_ORDER = (PASS, NEAR, MULTI, PARTIAL, NINE, OUTLINE)
STATUS_LABEL = {
    PASS: "Buildable now",
    NEAR: "Near misses (1-3 holes to fix in OSM)",
    MULTI: "Multi-course facilities (holes need splitting by course)",
    PARTIAL: "Partly mapped",
    NINE: "9-hole layouts",
    OUTLINE: "Outline only (no hole lines)",
}
NEAR_MAX_HOLES = 3

NO_LINE = "no hole line"
DUPLICATE_LINE = "more than one hole line with this number"
NO_GREEN = "no green polygon at the end of the hole line"
NO_TEE = "no tee near the start of the hole line"


@dataclass
class HoleAudit:
    number: int
    has_line: bool
    has_green: bool
    tee_count: int
    par: int | None = None
    par_source: str | None = None
    length_yd: float | None = None  # along the hole line as drawn
    reversed: bool = False
    problems: list[str] = field(default_factory=list)


@dataclass
class CourseAudit:
    id: str
    name: str
    status: str
    hole_lines: int
    holes_ok: int
    problems: list[str]
    holes: list[HoleAudit]
    info: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == PASS

    @property
    def par(self) -> int | None:
        pars = [h.par for h in self.holes if h.par]
        return sum(pars) if len(pars) == 18 else None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["par"] = self.par
        return d


def _ranges(numbers: list[int]) -> str:
    """[1, 2, 3, 7, 9, 10] -> '1-3, 7, 9-10'"""
    out, start, prev = [], None, None
    for n in sorted(numbers):
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append(f"{start}" if start == prev else f"{start}-{prev}")
            start = prev = n
    if start is not None:
        out.append(f"{start}" if start == prev else f"{start}-{prev}")
    return ", ".join(out)


def audit_course(cd: CourseData, info: dict | None = None) -> CourseAudit:
    holes: list[HoleAudit] = []
    for n in range(1, 19):
        h = cd.holes.get(n)
        if h is None:
            problem = DUPLICATE_LINE if n in cd.duplicate_refs else NO_LINE
            holes.append(HoleAudit(n, False, False, 0, problems=[problem]))
            continue
        ha = HoleAudit(
            n,
            True,
            h.green is not None,
            len(h.tees),
            h.par,
            h.par_source,
            round(m_to_yd(h.line.length), 1),
            h.reversed,
        )
        if h.green is None:
            ha.problems.append(NO_GREEN)
        if not h.tees:
            ha.problems.append(NO_TEE)
        holes.append(ha)

    problems: list[str] = []
    for label in (NO_LINE, DUPLICATE_LINE, NO_GREEN, NO_TEE):
        nums = [h.number for h in holes if label in h.problems]
        if nums:
            problems.append(f"{label}: hole{'s' if len(nums) > 1 else ''} {_ranges(nums)}")
    extra = sorted(n for n in cd.holes if n > 18)
    if extra:
        problems.append(f"hole numbers above 18: {_ranges(extra)}")
    if cd.unnumbered:
        problems.append(f"{len(cd.unnumbered)} hole line(s) without a ref number")

    bad = [h for h in holes if h.problems]
    numbers = set(cd.holes) | set(cd.duplicate_refs)
    if cd.hole_line_count == 0:
        status = OUTLINE
    elif cd.duplicate_refs or extra:
        status = MULTI
    elif not bad:
        status = PASS
    elif numbers and max(numbers) <= 9 and cd.hole_line_count <= 9:
        status = NINE
    elif len(bad) <= NEAR_MAX_HOLES:
        status = NEAR
    else:
        status = PARTIAL

    return CourseAudit(
        id=cd.course.id,
        name=cd.name,
        status=status,
        hole_lines=cd.hole_line_count,
        holes_ok=18 - len(bad),
        problems=problems,
        holes=holes,
        info=info or {},
    )
