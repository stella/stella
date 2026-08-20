# @stll/money

Branded minor-unit monetary values and exact billing arithmetic for Stella.

The package keeps money in integer minor units, rejects fractional cents, and
separates totals by currency so incompatible amounts cannot be combined.

```ts
import { MoneyTotals, cents } from "@stll/money";

const totals = new MoneyTotals();
totals.add("EUR", cents(1250));
```

Public API changes require a changeset.
