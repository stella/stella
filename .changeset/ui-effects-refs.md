---
"@stll/ui": minor
---

`@stll/ui/effects-refs` adds `useComposedRefs`: one ref callback for several refs that keeps its identity while the refs do, so React does not detach and re-attach every member on each render the way a `composeRefs(...)` call during render does.
