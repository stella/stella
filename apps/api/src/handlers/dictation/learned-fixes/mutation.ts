import type { AggregateMutationDeclaration } from "@/api/lib/db/aggregate-mutation-declaration";

/** Every write to a member's learned fixes replaces their one row at the revision it read. */
export const LEARNED_FIXES_MUTATION = {
  type: "independent",
  reason:
    "One row per member, replaced only at the revision it read; a write that lost a race reads again.",
} as const satisfies AggregateMutationDeclaration;
