---
"@stll/conditions": minor
---

Export `foldCondition`/`foldConditions`, a generic fold over the condition tree that owns the drop rule for a group with no surviving children, so every consumer that reads which nodes a filter compiles to agrees on the same structural semantics.
