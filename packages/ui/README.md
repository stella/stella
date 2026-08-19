# @stll/ui

Stella's design system: the React primitives the product surfaces are built
from, the dockable inspector pane, and the Tailwind v4 theme they are styled
with.

The package is self-contained by construction. It imports no application
module, no path alias, and no other workspace package, so every component can
be rendered and tested without a surrounding application — and a change to one
cannot reach into product code by accident. Lint enforces that boundary; the
export map below is what "part of the design system" means.

Peer dependencies: `react`, `react-dom`, `@base-ui/react`, `tailwindcss` (v4).

## Import

Every module has its own subpath, and the package declares `sideEffects: false`,
so a bundler keeps only what is imported:

```tsx
import { Button } from "@stll/ui/components/button";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { Inspector, InspectorDock } from "@stll/ui/inspector";
import { cn } from "@stll/ui/lib/utils";
```

`@stll/ui` re-exports all of them under one specifier for convenience; the
subpaths are the real surface, and in-repo code uses those.

## Styles

No compiled CSS ships. The components carry Tailwind class names, so the
Tailwind build stays with the application that uses them:

```css
@import "tailwindcss";
@import "@stll/ui/theme.css";
@source "../node_modules/@stll/ui/dist";
```

`theme.css` carries the `@theme` token map, the palettes, the base layer, and
the custom utilities. The `@source` line is what makes Tailwind scan the
shipped components for the utilities they use — node_modules is outside its
default source detection.

`@stll/ui/globals.css` is this repository's own Tailwind entry: the import
above plus the source globs for the workspaces in this checkout.

## Layout direction

The components are bidirectional. Use logical properties (`ms-*`, `pe-*`,
`start-*`) rather than physical ones, and let the slots that render
caller-supplied values (names, identifiers, filenames) keep their `dir="auto"`
and bidi isolation.

## Development

```sh
bun run build       # tsdown, one output module per source module, with .d.ts
bun run test        # bun test src
bun run typecheck
bun run lint
```

`bun scripts/check-published-exports.ts packages/ui` (from the repository root)
runs the publish path end to end: build, `prepare-publish`, `bun pm pack`, then
resolves and imports every declared subpath from the built `dist`.
