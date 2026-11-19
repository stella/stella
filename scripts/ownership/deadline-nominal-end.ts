import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "deadline-nominal-end",
  capability: "Deadline calculation and nominal period arithmetic",
  owner: ["packages/deadlines/"],
  summary:
    "`@stll/deadlines` owns nominal ISO calendar arithmetic and the public " +
    "configuration-driven `createDeadlineCalculator` engine; `computeDeadline` " +
    "binds its default CZ/SK rules. It reuses Temporal from `@stll/time`, " +
    "configures trigger inclusion, counting, month ends, adjustment direction " +
    "and court closures, and explains each shift with a rule source. The replaceable " +
    "holiday adapter alone imports date-holidays; its verified calendar " +
    "coverage is CZ 2016–2026 and SK 2019–2026. Unsupported dates, provider " +
    "failures and bounded-adjustment failures return typed errors.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
