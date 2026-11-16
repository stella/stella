import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "verification-claim-asserted-date-read",
  capability: "Reading the date a verified claim asserts",
  owner: ["apps/api/src/lib/lists/verification/read-run.ts"],
  summary:
    "A claim row keeps the asserted date its run read; a re-check records " +
    "its own reading in the review log, and a claim written before claims " +
    "carried dates stays `pending` until the backfill reads its words. " +
    "Every surface reads the date through `assertedDateOfClaim`, which " +
    "prefers the latest re-check and reads a pending claim's words the way " +
    "the backfill stores them. A surface that read the columns would show " +
    "no date for a claim that has one and miss a re-check's reading.",
  enforcement: {
    kind: "table-column-read",
    specifiers: ["@/api/db/schema", "@/api/db/schema/lists-verification"],
    table: "legalListClaims",
    columns: ["assertedOn", "assertedOnPrecision", "assertedOnSource"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
