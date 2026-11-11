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
    "the claim's current review (null while nobody has acted on it). " +
    "`carryOver` says what the run took from the previous run of the same " +
    "document and list: reviewer decisions follow a claim with the same " +
    "words, or edited words in the same paragraph or page; notes and fact " +
    "links always, other decisions only when the verdict is unchanged. It " +
    "counts the reviewed claims that came across whole and lists the rest " +
    "(`verdict-changed`, `unmatched`, `ambiguous`); null when there was " +
    "nothing to carry.",
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
