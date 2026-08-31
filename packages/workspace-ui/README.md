# @stll/workspace-ui

Reusable workspace presentation components and view helpers for Stella.

## Saved views

`@stll/workspace-ui/view-switcher` exports a controlled saved-view strip with
keyboard selection, horizontal overflow, inline editing slots, and bidi-aware
Pragmatic Drag and Drop reordering. Hosts retain ownership of persistence,
permissions, translations, menus, and layout rendering.

Reusable React presentation modules for Stella workspaces: field values,
property icons, sorting chips, condition builders, table loading rows, and
column calculations.

The package owns view-level rendering contracts while the surrounding workspace
supplies its data, labels, and locale. The condition builder resolves no
strings itself; labels and field options arrive through its props.

## Imports

Use the explicit subpaths for focused modules:

```tsx
import { ConditionBuilder } from "@stll/workspace-ui/conditions";
import { FieldValue } from "@stll/workspace-ui/field-value";
import { SortChips } from "@stll/workspace-ui/sorts";
import { WorkspaceViewSwitcher } from "@stll/workspace-ui/view-switcher";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@stll/workspace-ui/responsive-action-toolbar";
```

The package also exposes a root entry for code that uses several workspace
surfaces together. Focused modules, including the responsive action toolbar,
are intentionally available through explicit subpaths; use those subpaths to
declare a module's
boundary.

## Development

```sh
bun run build       # tsdown, one output module per source module
bun run test        # bun test src
bun run typecheck
bun run lint
```

Peer dependencies: `react`, `react-dom`, `@base-ui/react`, Pragmatic Drag and
Drop v3 with its hitbox package, TanStack React Table, and Tailwind CSS v4. The
package's components use Tailwind utility classes; the host owns the Tailwind
entry point and token configuration.

Include both published component packages in that entry point so Tailwind scans
their shipped class names:

```css
@import "tailwindcss";
@import "@stll/ui/theme.css";
@source "../node_modules/@stll/ui/dist";
@source "../node_modules/@stll/workspace-ui/dist";
```

This package is published, so public API changes need a changeset.
