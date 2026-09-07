---
"@stll/cli": minor
---

The entity readers take a `find` filter: `entities.read-window`, the kanban group reader and the group-counts reader accept `body.find` (via `--input`, like the other structured body fields), narrowing rows to those whose displayed name or chosen columns contain a literal substring. It is not `search`, which ranks an asynchronous index of document titles and adds sort keys; a find filters exactly what the grid renders. `find.scope.type` `all` also matches the row's name, `columns` matches only `find.scope.propertyIds`. `find.term` is at least three characters once trimmed: the cells are read through a trigram index, which a shorter term cannot use.
