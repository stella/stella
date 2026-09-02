---
"@stll/ui": minor
---

Add `InspectorEntityTab` (a rail tab for an open entity: the active tab's icon or a short glyph for every inactive one, with a tooltip and a middle-click close) and its `entityTabGlyph` helper, plus `InspectorFacetBar` (the inspector's overflow-aware row of facet chips) to `@stll/ui/inspector`, so a host can render the same open-entity rail and facet row without rebuilding them locally.
