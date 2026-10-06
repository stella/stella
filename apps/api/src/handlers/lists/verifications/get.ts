import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { recordVerificationRead } from "@/api/lib/lists/verification/read-audit";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";

const config = {
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read one list verification: the document version it checked, the list " +
    "facts it checked against as they stood then, and every claim found in " +
    "the document with its verdict (state, and a 0-100 support score for " +
    "supported, tension and contradicted), the facts it rests on, and the " +
    "claim's current review (null while nobody has acted on it).",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({ runId: tSafeId("legalListVerificationRun") }),
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
