---
"@stll/ui": minor
---

`@stll/ui/effects-dom` keeps React state from the DOM without effect loops: `useObservedValue` (the primitive, with an equality guard and a breaker for layout feedback), `useLayoutMeasurement`, `useElementSize`, `useIntersecting` and a shared, reference-counted `useObjectUrl`. `@stll/ui/effects` adds `useNow`, one shared clock per interval.
