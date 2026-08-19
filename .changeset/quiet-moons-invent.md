---
"@stll/ui": minor
---

Publish the design system as a versioned package with an explicit export map.

`@stll/ui` was a private workspace whose `exports` were wildcards over `./src`,
so nothing checked that a module belonged in the design system: the boundary
between reusable primitive and application code was a convention. It now
declares one flat subpath per module — `@stll/ui/button`, `@stll/ui/use-mobile`,
`@stll/ui/utils`, `@stll/ui/inspector` — plus `sideEffects: false` and peer
dependencies on React, Base UI, and Tailwind, and builds with tsdown to one
output module per source module with declarations.

The grouped subpaths `@stll/ui/components/<name>`, `@stll/ui/hooks/<name>`, and
`@stll/ui/lib/<name>` are deprecated. They still resolve to the same modules
and will be removed after this minor.

The theme moves out of the repository-specific Tailwind entry into
`@stll/ui/theme.css`, which carries the token map, palettes, base layer, and
custom utilities; no compiled CSS ships. The dockable inspector pane is a
module of the package (`@stll/ui/inspector`) rather than markup and arithmetic
spread across route files.
