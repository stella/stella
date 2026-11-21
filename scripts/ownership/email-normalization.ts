import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "email-normalization",
  capability: "Deciding whether two email addresses are the same address",
  owner: ["apps/api/src/lib/email/normalized-email.ts"],
  summary:
    "Account lookups, demo, review and system account checks, rate-limit " +
    "and one-time-code keys, identity linking and allowed senders compare " +
    "addresses through `normalizeEmail`, the form Better Auth stores; SQL " +
    "compares a stored column through `emailColumnMatches`, and configuration " +
    "validates through `emailAddressSchema`.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-adhoc-email-fold/no-adhoc-email-fold",
    reason:
      "The guard must recognize a fold by the name of the value it reads, " +
      "a lowercase action inside an address schema, and a case fold opened " +
      "around an address column in an SQL template.",
  },
} as const satisfies OwnershipEntry;
