# @stll/calculations

Typed, unit-safe reducers for Stella workspace columns.

The package provides counting, numeric and monetary reductions, including
view-scoped percentages. Mixed units remain unsupported instead of producing a
misleading total.

```ts
import { runCalculation } from "@stll/calculations";
```

Public API changes require a changeset.
