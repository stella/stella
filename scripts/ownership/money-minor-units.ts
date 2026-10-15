import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "money-minor-units",
  capability: "Converting between major and minor units of a currency",
  owner: ["packages/money/src/format.ts"],
  summary:
    "How many minor units make a major one is a property of the currency: " +
    "100 for USD, 1 for JPY, 1000 for KWD. `toMinorUnits`, `toMajorUnits`, " +
    "and `formatMoneyCents` all ask `currencyMinorUnitDigits` here, and the " +
    "`no-literal-minor-unit-scale` rule reports a money value scaled by a " +
    "literal 100 anywhere in `apps/*/src` or `packages/*/src`.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
