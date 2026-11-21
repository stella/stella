import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "verification-run-evidence-read",
  capability: "Reading persisted verification run evidence",
  owner: ["apps/api/src/lib/lists/verification/read-run.ts"],
  summary:
    "The verification run reader supplies contested fact identities, grading evidence and the list identity projection. Direct evidence column access and full-row reads stay inside the reader.",
  enforcement: {
    kind: "table-column-read",
    specifiers: ["@/api/db/schema", "@/api/db/schema/lists-verification"],
    table: "legalListVerificationRuns",
    columns: ["evidence"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
