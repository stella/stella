import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { findSimilarDocuments } from "@/api/lib/uploads/near-duplicates/find-similar";

const readSimilarDocumentsParamsSchema = workspaceParams({
  entityId: resourceIdSchema("entity", { description: "Document entity ID" }),
});

const config = {
  contract: "patch",
  description:
    "List the other documents in the matter whose current text is nearly the " +
    "same as this document's current text, most similar first, each with an " +
    "estimated similarity between 0 and 1. Other versions of the same " +
    "document are not listed.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  access: "read",
  params: readSimilarDocumentsParamsSchema,
} satisfies WorkspaceHandlerConfig;

const readSimilarDocuments = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    const documents = yield* Result.await(
      safeDb(
        async (tx) =>
          await findSimilarDocuments({
            tx,
            workspaceId,
            entityId: params.entityId,
          }),
      ),
    );
    return Result.ok({ documents });
  },
);

export default readSimilarDocuments;
