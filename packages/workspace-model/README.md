# `@stll/workspace-model`

Portable entity-property definitions and values for workspace-style products.
The package has no UI, database, or framework dependency: hosts own storage,
authorization, validation bounds, translations, and rendering.

Definitions use stable keys and identifiers. Select option labels and colours
remain presentation metadata, while stored values reference option identifiers;
renaming a label therefore does not rewrite entity data.

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
