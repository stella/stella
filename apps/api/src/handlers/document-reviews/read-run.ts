/**
 * Read one document review run and its findings.
 *
 * The projection itself lives in `lib/document-review/read-run-detail`, because
 * the history list answers with the same shape for its newest run.
 */

import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { readDocumentReviewRunDetail } from "@/api/lib/document-review/read-run-detail";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Read one document review run: its status, progress, pinned basis, and the findings committed so far.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("documentReviewRun") }),
} satisfies HandlerConfig;

const readDocumentReviewRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, session, workspaceId }) {
    const detail = yield* readDocumentReviewRunDetail({
      safeDb,
      workspaceId,
      organizationId: session.activeOrganizationId,
      runId: params.runId,
    });
    if (detail === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Review run not found" }),
      );
    }
    return Result.ok(detail);
  },
);

export default readDocumentReviewRun;
