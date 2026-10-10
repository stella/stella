import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  projectProvisionPreview,
  provisionPreviewSuccessResponseSchema,
} from "@/api/handlers/legislation/reader-response";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  buildProvisionPreview,
  previewVersionColumns,
} from "@/api/lib/legal-search/legislation-provision-preview";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import { buildLegislationDocumentAppUrl } from "@/api/lib/legal-search/public-law-app-urls";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

const PREVIEW_READ_STEP = "provisionPreview.corpusAst";

const config = {
  response: safePublicHandlerResponseSchemasWithStatusText(
    provisionPreviewSuccessResponseSchema,
  ),
  cache: { kind: "public", maxAge: 3600, swr: 86_400 },
  // Not a capability: a cacheable browser citation-preview read gated
  // by the public-law route hook, neither of
  // which the generic invoke path can honor. Agents read provision text
  // through `read_statute_provisions`, which is where the MCP contract lives.
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
            publishedLegislationDocument,
          ),
        )
        .limit(1),
  );

  if (version === undefined) {
    return status(404, { message: "Legislation document not found" });
  }

  // Outside the transaction above: the AST lives in object storage.
  const blocks = await readVersionBlocks({
    row: version,
    legislationDb,
    step: PREVIEW_READ_STEP,
  });
  const preview = buildProvisionPreview({
    version,
    blocks,
    anchor,
    citedAnchor,
  });

  if (preview.blocks.length === 0) {
    return status(404, { message: "Provision not found" });
  }

  return {
    ...projectProvisionPreview(preview),
    appUrl: buildLegislationDocumentAppUrl({
      country: version.country,
      documentId: version.id,
      eli: version.eli,
      slug: version.slug,
      version: version.versionValidFrom,
      anchor: citedAnchor ?? anchor,
    }),
  };
};

const readProvisionPreview = createSafeBoundedPublicHandler(
  config,
  async function* ({ params: { documentId, anchor }, query }) {
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

    return Result.ok(
      "blocks" in response ? projectProvisionPreview(response) : response,
    );
  },
);

export default readProvisionPreview;
