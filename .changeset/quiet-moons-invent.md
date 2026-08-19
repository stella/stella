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

`@stll/ui/theme.css` is now the only stylesheet the package exports: the token
map, the palettes, the base layer, and the custom utilities. No compiled CSS
ships, and each application owns its own Tailwind entry rather than importing a
repository-specific one from the package. The dockable inspector pane is a
module of the package (`@stll/ui/inspector`) rather than markup and arithmetic
spread across route files.
