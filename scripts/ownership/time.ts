import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "time",
  capability:
    "Temporal runtime, calendar-date arithmetic, ISO date-only parsing, durations",
  owner: ["packages/time/"],
  summary:
    "`@stll/time` exports the side-effect-free `temporal-polyfill/full` " +
    "ponyfill, which selects native Temporal when available. Runnable apps " +
    "and private workspace packages import it from this owner; published " +
    "packages declare and import the ponyfill directly. Runtime entrypoints never " +
    "install an ambient global. A calendar day is not 24 hours across a " +
    "DST transition, so moving to another date uses Temporal calendar " +
    "arithmetic. Elapsed-time math uses the duration constants. The date " +
    "lint rules route callers here and reserve legacy `Date` for named " +
    "library boundaries. See [Temporal conventions](../temporal.md).",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
