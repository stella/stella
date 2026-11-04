import { panic, Result } from "better-result";
import { desc, eq } from "drizzle-orm";

import { legislationDocuments, legislationMatterLinks } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type MatterLinkRow = typeof legislationMatterLinks.$inferSelect;
const toMatterLinkListItem = (row: MatterLinkRow) => ({
  id: row.id,
  statuteId: row.statuteId,
  provisionId: row.provisionId,
  appliedVersion: row.appliedVersion,
  jurisdiction: row.jurisdiction,
  linkedBy: row.linkedBy,
  createdAt: row.createdAt,
});
const UNPROJECTED_LINK_COLUMNS = [
  // The authorized route already identifies the matter.
  "workspaceId",
  // The public statute identity and applied version identify the consolidation.
  "documentId",
] as const satisfies readonly (keyof MatterLinkRow)[];
type MatterLinkListItem = ReturnType<typeof toMatterLinkListItem>;
true satisfies UnprojectedColumns<
  MatterLinkRow,
  MatterLinkListItem,
  (typeof UNPROJECTED_LINK_COLUMNS)[number]
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  MatterLinkRow,
  MatterLinkListItem,
  (typeof UNPROJECTED_LINK_COLUMNS)[number]
> extends never
  ? true
  : never;

const config = {
  contract: "patch",
  description:
    "List statute provisions linked to the current matter, newest first, including the statute title, jurisdiction and exact applied version date. Returns the complete set up to the per-matter link cap.",
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
          await scopedDb(async (tx) => {
            const read = await readBounded(
              tx
                .select({
                  link: legislationMatterLinks,
                  statuteTitle: legislationDocuments.title,
                })
                .from(legislationMatterLinks)
                .innerJoin(
                  legislationDocuments,
                  eq(
                    legislationDocuments.id,
                    legislationMatterLinks.documentId,
                  ),
                )
                .where(eq(legislationMatterLinks.workspaceId, workspaceId))
                .orderBy(
                  desc(legislationMatterLinks.createdAt),
                  desc(legislationMatterLinks.id),
                ),
              LIMITS.legislationMatterLinksPerWorkspace,
            );
            if (read.type === "overflow") {
              return panic(
                "Legislation matter links exceed the per-matter cap",
              );
            }
            return read.rows.map(({ link, statuteTitle }) => ({
              ...toMatterLinkListItem(link),
              statuteTitle,
            }));
          }),
      ),
    );
    return Result.ok({ links });
  },
);
