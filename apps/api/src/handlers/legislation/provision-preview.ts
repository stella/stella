import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  buildProvisionPreview,
  previewVersionColumns,
} from "@/api/lib/legal-search/legislation-provision-preview";
import { redistributableLegislationSource } from "@/api/lib/legal-search/legislation-redistribution";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

const PREVIEW_READ_STEP = "provisionPreview.corpusAst";

/**
 * How long a provision preview may be reused. A consolidation's wording is
 * fixed once published: an amendment is a new consolidation with its own id,
 * so an answer addressed by document id and anchor changes only when the
 * corpus is reparsed. The freshness trade is against a reparse, never against
 * a change in the law, and an unauthenticated read carries no session, so the
 * answer is shareable.
 */
const PROVISION_PREVIEW_CACHE_CONTROL =
  "public, max-age=3600, stale-while-revalidate=86400";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({
    documentId: tSafeId("legislationDocument"),
    anchor: t.String({ minLength: 1, maxLength: 256 }),
  }),
  query: t.Object({
    /**
     * The subdivision the citation named (`par_1729-odst_1`), when it named
     * one. The preview then shows that block instead of the whole provision.
     */
    citedAnchor: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  }),
} satisfies PublicHandlerConfig;

type ReadProvisionPreviewOptions = {
  documentId: SafeId<"legislationDocument">;
  anchor: string;
  citedAnchor: string | undefined;
  legislationDb: LegislationReadDb;
};

/**
 * The blocks a citation preview shows, read from one consolidation.
 *
 * The caller addresses the consolidation it links to, so the wording shown
 * and the wording a click opens are the same text. Choosing a consolidation
 * by date belongs to the reads that own that decision (`by-eli`, the version
 * list, and the decision's own provision list), not here.
 */
export const readProvisionPreviewHandler = async ({
  documentId,
  anchor,
  citedAnchor,
  legislationDb,
}: ReadProvisionPreviewOptions) => {
  const [version] = await legislationDb(
    async (tx) =>
      await tx
        .select({ ...previewVersionColumns, ...versionAstColumns })
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            eq(legislationDocuments.id, documentId),
            redistributableLegislationSource,
          ),
        )
        .limit(1),
  );

  if (version === undefined) {
    return status(404, { message: "Legislation document not found" });
  }

  // Outside the transaction above: the AST lives in object storage.
  const blocks = await readVersionBlocks(version, PREVIEW_READ_STEP);
  const preview = buildProvisionPreview({
    version,
    blocks,
    anchor,
    citedAnchor,
  });

  if (preview.blocks.length === 0) {
    return status(404, { message: "Provision not found" });
  }

  return preview;
};

const readProvisionPreview = createSafePublicHandler(
  config,
  async function* ({ params: { documentId, anchor }, query, set }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readProvisionPreviewHandler({
            documentId,
            anchor,
            citedAnchor: query.citedAnchor,
            legislationDb: legislationPublicReadDb,
          }),
      ),
    );

    set.headers["cache-control"] = PROVISION_PREVIEW_CACHE_CONTROL;

    return Result.ok(response);
  },
);

export default readProvisionPreview;
