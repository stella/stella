import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "verification-claim-grade-read",
  capability: "Reading the grade a verification run wrote for a claim",
  owner: ["apps/api/src/lib/lists/verification/read-run.ts"],
  summary:
    "A claim row keeps the grade its run wrote; re-checks, reopenings and " +
    "record-conflict resolutions live in the review log. Every surface " +
    "reads a claim as its reviewers see it (`gradeOf`, `reviewedView` in " +
    "review-fold.ts), so the written grade is read only where it is " +
    "resolved through them: the run reader, the run summaries (which count " +
    "written grades in SQL, then move each reviewed claim through " +
    "`reviewedView`) and the review history (which reads every step " +
    "through `claimDisposition`). A summary that counted written grades " +
    "would disagree with the verification view the moment a claim is " +
    "re-checked.",
  enforcement: {
    kind: "table-column-read",
    specifiers: ["@/api/db/schema", "@/api/db/schema/lists-verification"],
    table: "legalListClaims",
    columns: ["state", "recordConflict"],
    allowed: [
      {
        path: "apps/api/src/lib/lists/verification/run-summary.ts",
        reason:
          "Counts written grades in SQL, then moves every claim with a view-changing review event through `reviewedView` (`countAsReviewed`).",
      },
      {
        path: "apps/api/src/lib/lists/verification/review-history.ts",
        reason:
          "Reads each history step through `claimDisposition`, which resolves the grade with `reviewedView`.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
