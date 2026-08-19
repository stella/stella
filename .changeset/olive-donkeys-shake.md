---
"@stll/ui": minor
---

Export the data table's column schema.

`@stll/ui/data-table` describes what a table's columns are, independent of how
they draw: an ordered list of descriptors, each with an id, a label, a starting
width, its capabilities (sort, hide, resize, pin) and an emphasis. Nothing in it
looks inside a descriptor's render payload, so a caller keeps its own
exhaustively checked union there and the schema stays free of any idea about
what a row holds.

Two rules belong to the schema rather than to a renderer: a column that cannot
be hidden stays visible whatever the stored hidden list says, so a stale list
cannot strand a table without its selection column; and `duplicateColumnIds`
reports a repeated id, which would otherwise drop a column silently because the
table keys by id.
