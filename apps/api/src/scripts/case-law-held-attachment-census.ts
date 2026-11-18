/**
 * Print the held-decision attachment census: per source that declares
 * `HeldDecisionAttachment`, the attached records whose host is gone or
 * redacted and the decisions stored as rows of their own whose ECLI a host
 * decision also carries (both should be 0), and how many records are parked
 * as ambiguous. Read-only.
 *
 *   bun run src/scripts/case-law-held-attachment-census.ts
 */
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { readHeldDecisionAttachmentCensus } from "@/api/lib/case-law/held-decision-attachment-census";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";

await runScriptWithErrorOutput(async () => {
  // Only reads, so it takes no lane and never blocks a writer.
  const { ingestionDb } = await openCaseLawReadOnlySession();
  const census = await ingestionDb(
    async (tx) => await readHeldDecisionAttachmentCensus(tx),
  );
  console.log(JSON.stringify(census, null, 2));
});
