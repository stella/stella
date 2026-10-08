import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "aggregate-lock",
  capability: "Acquiring transaction aggregate locks",
  owner: [
    "apps/api/src/lib/db/aggregate-lock.ts",
    "apps/api/src/lib/db/transaction-abort.ts",
  ],
  summary:
    "One registry orders blocking aggregate acquisitions across the physical transaction. " +
    "Explicit row modes govern held coverage; blocking upgrades require the strongest mode first. " +
    "TRY and NOWAIT requests return typed busy results. " +
    "Registered chains enforce rank order. Selected-row acquisitions compose the registered identity and tenant " +
    "predicate before locking; caller predicates can only narrow it and caller locking clauses are rejected. " +
    "Returned physical identity and tenant scope are checked against registered projected columns. " +
    "The owner closes transaction histories, links savepoint levels, merges acquired locks on release, " +
    "and discards them on rollback. The confinement rule and exact-site inventory " +
    "reject raw acquisitions and transaction boundaries outside the owner; " +
    "existing sites remain in a reasoned shrinking baseline. Mutation route " +
    "enumeration requires a declaration or a legacy entry.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
