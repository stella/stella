import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "aggregate-lock",
  capability: "Acquiring transaction aggregate locks",
  owner: ["apps/api/src/lib/db/aggregate-lock.ts"],
  summary:
    "One registry orders aggregate acquisitions across the physical transaction. " +
    "The owner links savepoint levels, merges acquired locks on release, and " +
    "discards them on rollback. The confinement rule and exact-site inventory " +
    "reject raw acquisitions and transaction boundaries outside the owner; " +
    "existing sites remain in a reasoned shrinking baseline. Mutation route " +
    "enumeration requires a declaration or a legacy entry.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
