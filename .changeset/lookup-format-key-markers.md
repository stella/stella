---
"@stll/api": patch
---

A registry lookup field addresses every one of its output formats by
`{{path.key}}`, and the first format is additionally what a bare `{{path}}`
marker renders. A template whose only markers are the keyed ones therefore
fills from a single registry round trip, and `path` is configurable as the
lookup even though no `{{path}}` marker exists. A path the document writes as
its own marker is no longer dropped as a namespace parent, so it fills instead
of surviving as literal text. Overlay rejections now travel in the structured
error envelope with an `issues[].path` per offending entry, a lookup format key
colliding with a separately configured field at the same path is refused naming
both, and a field naming two derived sources says which two. The
`list_templates` detail payload echoes the whole field configuration —
registry, validation, binding source, `aiSeesDocument`, and the derived rules
keyed the way the `fields` overlay names them.
