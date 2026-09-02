---
"@stll/ui": patch
---

Kanban column bands take a caption's height, not a panel's. The band line is
one 28px row (toggle, swatch, name, count) over a hairline instead of a boxed
header, bands no longer stretch to the tallest one, and a folded band shows
only its toggle in that line while its name is set vertically in the narrow
column body over the count. A folded band peeks open on pointer movement
inside its slot rather than on entering it, so a band folded under a resting
pointer stays folded.
