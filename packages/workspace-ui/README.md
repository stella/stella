# @stll/workspace-ui

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
```

The package also exposes a root entry for code that uses several workspace
surfaces together. The subpaths remain the clearest way to declare a module's
boundary.

## Development

```sh
bun run build       # tsdown, one output module per source module
bun run test        # bun test src
bun run typecheck
bun run lint
```

Peer dependencies: `react`, `react-dom`, `@base-ui/react`, and Tailwind CSS
v4. The package's components use Tailwind utility classes; the host owns the
Tailwind entry point and token configuration.

This package is published, so public API changes need a changeset.
