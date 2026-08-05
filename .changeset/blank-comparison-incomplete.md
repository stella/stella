---
"@stll/conditions": patch
---

Treat a comparison against a blank literal as an incomplete filter for every
operator. `pruneIncomplete` previously excepted `eq`/`neq`, so a filter seeded
by a picker and never given a value compiled to a real constraint and matched
almost nothing. Blankness is expressed by `is_empty`.
