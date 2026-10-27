---
"@stll/workspace-ui": minor
---

Sort chips name their direction with the caller's wording for the property's sort kind. `SortableProperty` takes a required `sortKind` and `SortChipsLabels` a total `directions` record, both typed by the new `@stll/workspace-ui/column-sort` entry (`ColumnSortKind`, `SortDirection`, `SortDirectionLabels`). `sortDirectionHint` and its hard-coded `A→Z` / `1→9` / arrow hints are removed.
