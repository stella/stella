---
"@stll/ui": minor
---

`@stll/ui/table-shell` holds the table's markup with no popup or tooltip, so a loading view can draw the table it stands in for: `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableShellCell` (a cell that never cuts its text), `TableHeadLabel` and `SortableHeadFace`, a sortable head without behaviour. `@stll/ui/table` builds `Table`, `TableCell` and `SortableHead` from them, so both phases share one set of classes. `InputFace` takes the field's `size` and a `fieldClassName`, so a small search field's face has the field's height.
