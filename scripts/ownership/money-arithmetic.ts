import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "money-arithmetic",
  capability: "Monetary amounts and minor-unit arithmetic",
  owner: ["packages/money/"],
  summary:
    "Amounts are stored and computed in minor units behind a `CentsAmount` " +
    "brand, so a major-unit value cannot be mixed into minor-unit math. The " +
    "brand threads from the Drizzle column through the API boundary into the " +
    "browser only while every producer mints it here.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
