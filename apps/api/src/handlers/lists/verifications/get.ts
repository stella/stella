import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";

const config = {
  description:
    "Read one list verification: the document version it checked, the list " +
    "facts it checked against as they stood then, and every claim found in " +
    "the document with its verdict (state, and a 0-100 support score for " +
    "supported, tension and contradicted), the facts it rests on, and the " +
    "claim's current review (null while nobody has acted on it).",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("legalListVerificationRun") }),
} satisfies WorkspaceHandlerConfig;

const readVerification = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const run = yield* Result.await(
      safeDb(
        async (tx) =>
          await readVerificationRun({ tx, workspaceId, runId: params.runId }),
      ),
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
