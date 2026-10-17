import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "request-idempotency-receipts",
  capability: "Claiming, replaying and retaining create request receipts",
  owner: ["apps/api/src/lib/idempotency/request-receipts.ts"],
  summary:
    "One owner claims create intents, replays completed JSON responses, retains ambiguous pending work as an execution fence and deletes only expired completed receipts. Callers use its scoped operations; the receipt table stays private to this owner.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/request-idempotency"],
    names: ["requestIdempotencyReceipts"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
