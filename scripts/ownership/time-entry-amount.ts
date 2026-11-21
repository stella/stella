import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "time-entry-amount",
  capability: "Price recorded time with its no-charge disposition",
  owner: ["packages/money/"],
  summary:
    "timeEntryAmount requires the noCharge field and returns zero for no-charge time. " +
    "Invoice lines, exports and displayed time amounts use this calculation.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/money"],
    names: ["prorateHourlyCents"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
