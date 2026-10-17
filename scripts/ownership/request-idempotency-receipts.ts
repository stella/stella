import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "request-idempotency-receipts",
  capability: "Claiming, replaying and retaining create request receipts",
  owner: ["apps/api/src/lib/idempotency/request-receipts.ts"],
  summary:
    "One owner claims create intents, replays completed JSON responses, commits creates with their replay responses in one transaction, releases rolled-back intents and sweeps expired unlocked receipts. Pending rows become eligible after two minutes; the hourly bounded sweep skips active transaction locks. Callers use its scoped operations; the receipt table stays private to this owner.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/request-idempotency"],
    names: ["requestIdempotencyReceipts"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
