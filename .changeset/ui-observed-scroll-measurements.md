---
"@stll/ui": patch
---

OutlineRail and ScrollToTop take their tick positions and visibility from the observed-value hook, measured before the first paint and again on resize and scroll.
