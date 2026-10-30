import { Result } from "better-result";
import { desc, eq } from "drizzle-orm";

import { legislationDocuments, legislationMatterLinks } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "List statute provisions linked to the current matter, newest first, including each provision title, jurisdiction and exact applied version date.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "both",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;
export default createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId }) {
    const links = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb((tx) =>
            tx
              .select({
                id: legislationMatterLinks.id,
                statuteId: legislationMatterLinks.statuteId,
                provisionId: legislationMatterLinks.provisionId,
                appliedVersion: legislationMatterLinks.appliedVersion,
                jurisdiction: legislationMatterLinks.jurisdiction,
                linkedBy: legislationMatterLinks.linkedBy,
                createdAt: legislationMatterLinks.createdAt,
                title: legislationDocuments.title,
              })
              .from(legislationMatterLinks)
              .innerJoin(
                legislationDocuments,
                eq(legislationDocuments.id, legislationMatterLinks.documentId),
              )
              .where(eq(legislationMatterLinks.workspaceId, workspaceId))
              .orderBy(
                desc(legislationMatterLinks.createdAt),
                desc(legislationMatterLinks.id),
              )
              .limit(LIMITS.legislationMatterLinksPerWorkspace),
          ),
      ),
    );
    return Result.ok({ links });
  },
);
