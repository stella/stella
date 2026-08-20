# `@stll/workspace-model`

Portable entity-property definitions and values for workspace-style products.
The package has no UI, database, or framework dependency: hosts own storage,
authorization, validation bounds, translations, and rendering.

Definitions use stable keys and identifiers. Select option labels and colours
remain presentation metadata, while stored values reference option identifiers;
renaming a label therefore does not rewrite entity data.

Saved views hold presentation state only: filters, sorting, grouping, visible
properties, and layout-specific configuration all refer back to the same
entity collection. Switching layout therefore never creates a second copy of
entity state.

```ts
import type {
  WorkspacePropertyDefinition,
  WorkspacePropertyValue,
} from "@stll/workspace-model/properties";

const labels = {
  id: "labels",
  key: "labels",
  label: "Labels",
  revision: 1,
  status: "active",
  type: "multi-select",
  fallbackOptionId: null,
  options: [],
} satisfies WorkspacePropertyDefinition;

const value = {
  propertyId: labels.id,
  type: "multi-select",
  optionIds: [],
} satisfies WorkspacePropertyValue;
```

```ts
import type { WorkspaceSavedView } from "@stll/workspace-model/views";

const board = {
  id: "open-work",
  name: "Open work",
  position: 0,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    calculations: [],
    filters: [],
    groupByPropertyId: "workflow",
    hiddenProperties: [],
    sorts: [],
    type: "kanban",
    version: 1,
  },
} satisfies WorkspaceSavedView;
```
