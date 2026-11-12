import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { recordVerificationRead } from "@/api/lib/lists/verification/read-audit";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read one list verification: the document version it checked, the list " +
    "facts it checked against as they stood then, how each of those facts " +
    "stands on the list now (held or included; its tier: `document` when a " +
    "source is a document's record, `testimony` when its sources are only " +
    "witness accounts, `unsourced` without a source; see " +
    "lists.source-documents.update), and every claim found in " +
    "the document with its verdict (state, and a 0-100 support score for " +
    "supported, tension and contradicted), its qualifiers (caveats that " +
    "never change the verdict: the record is not expected to speak to the " +
    "point, a cited fact has a different scope, no document's record backs " +
    "it and it rests on testimony, every fact it rests on is unsourced, or " +
    "it rests on a held fact), the facts it " +
    "rests on, for a record conflict the fact suggested to govern it (the " +
    "document's record over a witness's account; null when neither), and " +
    "the claim's current review (null while nobody has acted on it). Each " +
    "claim's `staleness` says why its grade may no longer stand on the list " +
    "as it is now: a fact the grade cites was edited (`fact-changed`), held " +
    "out of scoring (`fact-held`) or taken off the list (`fact-removed`), or " +
    "a fact the grade never read bears on the claim (`new-fact-related`: " +
    "linked to it, from a cited fact's document, or on its words); empty " +
    "when none of these was found (a new fact on the claim's point in other " +
    "words is not detected), null when the list holds more facts than one " +
    "check reads. Nothing is graded again until asked: re-check those " +
    "claims with lists.verifications.claim-rechecks.bulk.create. " +
    "`assertedOn` is the date the claim's words give (`dated`, with a " +
    "`day`, `month` or `year` precision stored as its first day and its " +
    "`source`: the words, or the grader when they name no complete date), " +
    "or `none`. " +
    "`decider` says who decided the verdict: `llm` (with a `fallback` " +
    "reason when the organization's decision model was asked and its " +
    "answer was not used), or `decision-model` with its `model`, its " +
    "`confidence` and the state it `replaced`. " +
    "`carryOver` says what the run took from the previous run of the same " +
    "document and list. Notes and fact links follow a claim with the same " +
    "words or with edited words in the same paragraph or page; other " +
    "decisions follow only the same words with an unchanged verdict. It " +
    "counts the reviewed claims that came across whole and lists the rest " +
    "(`text-changed`, `verdict-changed`, `unmatched`, `ambiguous`); null " +
    "when there was nothing to carry.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({
    runId: resourceIdSchema("legalListVerificationRun"),
  }),
} satisfies WorkspaceHandlerConfig;

const readVerification = createSafeHandler(
  config,
  async function* ({
    params,
    safeDb,
    workspaceId,
    session,
    user,
    recordAuditEvent,
  }) {
    const run = yield* Result.await(
      safeDb(async (tx) => {
        const storedRun = await readVerificationRun({
          tx,
          workspaceId,
          runId: params.runId,
        });
        if (storedRun === null) {
          return null;
        }
        await recordVerificationRead({
          tx,
          run: storedRun,
          workspaceId,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          recordAuditEvent,
        });
        return storedRun;
      }),
    );
    if (run === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Verification not found" }),
      );
    }
    return Result.ok(run);
  },
);

export default readVerification;
