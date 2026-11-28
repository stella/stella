import { Result } from "better-result";
import * as v from "valibot";

import { CLAUSE_RESOLUTIONS } from "@stll/docx-engine/types";
import { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";
import type { TemplatePackCatalogue } from "@stll/template-packs";
import type { GeneratedTemplatePack } from "@stll/template-packs/schema";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { renderTemplatePreview } from "@/api/lib/docx/render-template-preview";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanFailedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import type { FileScanRejectedError } from "@/api/lib/file-scan/scan-upload";
import {
  findStarterPlaybook,
  STARTER_PLAYBOOK_IDS,
  STARTER_PLAYBOOKS,
} from "@/api/lib/workflow/starter-playbooks";
import type { StarterPlaybook } from "@/api/lib/workflow/starter-playbooks";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const packMetadata = (pack: GeneratedTemplatePack) => ({
  id: pack.id,
  name: pack.name,
  version: pack.version,
  description: pack.description,
  license: pack.license,
  licenseUrl: pack.licenseUrl,
  source: pack.source,
  authors: pack.authors,
  jurisdictions: pack.jurisdictions,
  languages: pack.languages,
  legalAreas: pack.legalAreas,
  lastReviewedAt: pack.lastReviewedAt,
  disclaimer: pack.disclaimer,
  templateCount: pack.templates.length,
});

const templateMetadata = (
  template: GeneratedTemplatePack["templates"][number],
) => ({
  id: template.slug,
  title: template.title,
  jurisdictions: template.jurisdictions,
  languages: template.languages,
  legalArea: template.legalArea,
  license: template.license,
  fields: template.fields,
  sha256: template.sha256,
});

const notFound = () =>
  Result.err(new HandlerError({ status: 404, message: "Not found" }));

/**
 * Hands a lookup over bundled, in-memory data to a safe handler through
 * `yield*`, the same short-circuit an awaited read uses. The result is
 * already settled; the promise only carries it into the async generator.
 */
const fromBundle = <T, E>(result: Result<T, E>) =>
  Result.await(Promise.resolve(result));

const findStarter = (id: string): Result<StarterPlaybook, HandlerError> => {
  const starter = findStarterPlaybook(id);
  return starter ? Result.ok(starter) : notFound();
};

const jurisdictionResponseSchema = v.object({
  country: v.pipe(v.string(), v.maxLength(8)),
  subdivision: v.optional(v.pipe(v.string(), v.maxLength(128))),
});

const authorResponseSchema = v.object({
  name: v.pipe(v.string(), v.maxLength(256)),
  organization: v.optional(v.pipe(v.string(), v.maxLength(256))),
  url: v.optional(v.pipe(v.string(), v.maxLength(2048))),
  role: v.picklist(["drafter", "reviewer", "converter"]),
  date: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

const sourceResponseSchema = v.object({
  name: v.pipe(v.string(), v.maxLength(256)),
  url: v.pipe(v.string(), v.maxLength(2048)),
  retrievedAt: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

const packMetadataResponseSchema = v.object({
  id: v.pipe(v.string(), v.maxLength(64)),
  name: v.pipe(v.string(), v.maxLength(256)),
  version: v.pipe(v.string(), v.maxLength(64)),
  description: v.pipe(v.string(), v.maxLength(4096)),
  license: v.pipe(v.string(), v.maxLength(128)),
  licenseUrl: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
  source: v.nullable(sourceResponseSchema),
  authors: v.pipe(v.array(authorResponseSchema), v.maxLength(64)),
  jurisdictions: v.pipe(v.array(jurisdictionResponseSchema), v.maxLength(64)),
  languages: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(32))),
    v.maxLength(32),
  ),
  legalAreas: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(128))),
    v.maxLength(64),
  ),
  lastReviewedAt: v.nullable(v.pipe(v.string(), v.maxLength(64))),
  disclaimer: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
  templateCount: v.number(),
});

const templateMetadataResponseSchema = v.object({
  id: v.pipe(v.string(), v.maxLength(64)),
  title: v.pipe(v.string(), v.maxLength(256)),
  jurisdictions: v.pipe(v.array(jurisdictionResponseSchema), v.maxLength(64)),
  languages: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(32))),
    v.maxLength(32),
  ),
  legalArea: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  license: v.pipe(v.string(), v.maxLength(128)),
  fields: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(256))),
    v.maxLength(512),
  ),
  sha256: v.pipe(v.string(), v.maxLength(64)),
});

const listPacksResponseSchema = v.object({
  items: v.pipe(v.array(packMetadataResponseSchema), v.maxLength(128)),
});

const readPackResponseSchema = v.object({
  ...packMetadataResponseSchema.entries,
  templates: v.pipe(v.array(templateMetadataResponseSchema), v.maxLength(256)),
});

const paragraphAlignmentSchema = v.picklist([
  "left",
  "center",
  "right",
  "both",
]);
const paragraphSourceSchema = v.picklist(["header", "body", "footer"]);

const tableCellParagraphSchema = v.object({
  text: v.pipe(v.string(), v.maxLength(65_536)),
  style: v.optional(v.pipe(v.string(), v.maxLength(128))),
  bold: v.optional(v.boolean()),
  fontSize: v.optional(v.number()),
  alignment: v.optional(paragraphAlignmentSchema),
});

const tableRowPositionSchema = v.union([
  v.object({
    table: v.number(),
    kind: v.literal("cells"),
    cells: v.pipe(
      v.array(
        v.object({
          paragraphs: v.pipe(
            v.array(tableCellParagraphSchema),
            v.maxLength(512),
          ),
        }),
      ),
      v.maxLength(64),
    ),
  }),
  v.object({
    table: v.number(),
    kind: v.picklist(["syntheticHeader", "delimiter"]),
  }),
]);

const previewParagraphSchema = v.object({
  index: v.number(),
  text: v.pipe(v.string(), v.maxLength(65_536)),
  source: v.optional(paragraphSourceSchema),
  style: v.optional(v.pipe(v.string(), v.maxLength(128))),
  bold: v.optional(v.boolean()),
  fontSize: v.optional(v.number()),
  alignment: v.optional(paragraphAlignmentSchema),
  tableRow: v.optional(tableRowPositionSchema),
  isDirective: v.optional(v.boolean()),
  directiveKind: v.optional(v.picklist(BLOCK_DIRECTIVE_KINDS)),
  directiveExpression: v.optional(v.pipe(v.string(), v.maxLength(4096))),
});

const clauseProvenanceSchema = v.object({
  slotKey: v.pipe(v.string(), v.maxLength(256)),
  resolution: v.optional(v.picklist(CLAUSE_RESOLUTIONS)),
  version: v.optional(v.number()),
  id: v.optional(v.pipe(v.string(), v.maxLength(128))),
  name: v.optional(v.pipe(v.string(), v.maxLength(256))),
});

const structureErrorSchema = v.object({
  message: v.pipe(v.string(), v.maxLength(2048)),
  paragraphIndex: v.number(),
  directive: v.pipe(v.string(), v.maxLength(2048)),
  source: v.optional(v.picklist(["header", "body", "footer", "clause"])),
  clause: v.optional(clauseProvenanceSchema),
});

const readTemplatePreviewResponseSchema = v.object({
  paragraphs: v.pipe(v.array(previewParagraphSchema), v.maxLength(20_000)),
  charCount: v.number(),
  structureErrors: v.pipe(v.array(structureErrorSchema), v.maxLength(1024)),
  clauseSlots: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(256))),
    v.maxLength(512),
  ),
});

const starterMetadataResponseSchema = v.object({
  id: v.picklist(STARTER_PLAYBOOK_IDS),
  name: v.pipe(v.string(), v.maxLength(256)),
  description: v.pipe(v.string(), v.maxLength(2048)),
  documentTypeKey: v.pipe(v.string(), v.maxLength(128)),
  positionCount: v.number(),
});

const listStartersResponseSchema = v.object({
  items: v.pipe(v.array(starterMetadataResponseSchema), v.maxLength(64)),
});

const starterAskContentResponseSchema = v.object({
  version: v.literal(1),
  type: v.picklist(["int", "text"]),
});

const starterTierRuleResponseSchema = v.object({
  id: v.pipe(v.string(), v.maxLength(64)),
  text: v.pipe(v.string(), v.maxLength(500)),
});

const starterFallbackEntryResponseSchema = v.object({
  id: v.pipe(v.string(), v.maxLength(64)),
  text: v.pipe(v.string(), v.maxLength(10_000)),
  label: v.optional(v.pipe(v.string(), v.maxLength(256))),
});

const starterDeterministicCheckResponseSchema = v.object({
  kind: v.literal("constraint"),
  condition: v.object({
    type: v.literal("compare"),
    left: v.object({
      type: v.literal("property"),
      propertyId: v.pipe(v.string(), v.maxLength(64)),
    }),
    op: v.literal("lte"),
    right: v.object({
      type: v.literal("literal"),
      value: v.number(),
    }),
  }),
});

const starterExtractPositionResponseSchema = v.object({
  mode: v.literal("extract"),
  sourceId: v.pipe(v.string(), v.maxLength(64)),
  issue: v.pipe(v.string(), v.maxLength(256)),
  ask: v.object({
    question: v.pipe(v.string(), v.maxLength(1000)),
    content: starterAskContentResponseSchema,
  }),
  guidance: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  enabled: v.boolean(),
});

const starterGradedPositionResponseSchema = v.object({
  mode: v.literal("graded"),
  sourceId: v.pipe(v.string(), v.maxLength(64)),
  issue: v.pipe(v.string(), v.maxLength(256)),
  severity: v.picklist(["blocker", "high", "medium", "low"]),
  enabled: v.boolean(),
  ask: v.object({
    mode: v.literal("manual"),
    question: v.pipe(v.string(), v.maxLength(1000)),
    content: starterAskContentResponseSchema,
  }),
  check: v.optional(starterDeterministicCheckResponseSchema),
  guidance: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  standard: v.object({
    source: v.literal("tiers"),
    tiers: v.object({
      acceptable: v.object({
        rules: v.pipe(v.array(starterTierRuleResponseSchema), v.maxLength(50)),
        ideal: v.optional(
          v.object({
            source: v.literal("inline"),
            text: v.pipe(v.string(), v.maxLength(10_000)),
          }),
        ),
      }),
      fallback: v.object({
        entries: v.pipe(
          v.array(starterFallbackEntryResponseSchema),
          v.maxLength(10),
        ),
      }),
      notAcceptable: v.object({
        rules: v.pipe(v.array(starterTierRuleResponseSchema), v.maxLength(50)),
      }),
    }),
  }),
  negotiation: v.optional(
    v.object({
      rationale: v.optional(v.pipe(v.string(), v.maxLength(2000))),
      talkingPoints: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.maxLength(500))), v.maxLength(20)),
      ),
      escalation: v.optional(v.pipe(v.string(), v.maxLength(500))),
    }),
  ),
});

const starterPositionsResponseSchema = v.object({
  version: v.literal(3),
  items: v.pipe(
    v.array(
      v.union([
        starterExtractPositionResponseSchema,
        starterGradedPositionResponseSchema,
      ]),
    ),
    v.maxLength(200),
  ),
});

const readStarterResponseSchema = v.object({
  ...starterMetadataResponseSchema.entries,
  positions: starterPositionsResponseSchema,
});

const packParams = v.object({
  packId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const templateParams = v.object({
  packId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  templateId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const starterParams = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});

const previewUnavailable = (cause: unknown) =>
  Result.err(
    new HandlerError({
      status: 503,
      code: "internal_error",
      message: "Preview unavailable",
      cause,
    }),
  );

const MAX_CACHED_PREVIEWS = 64;

type TemplatePreview = Awaited<ReturnType<typeof renderTemplatePreview>>;

/**
 * A bundled template's scan verdict and rendered preview. A render failure
 * rejects the promise instead.
 */
type PreviewOutcome = Result<
  TemplatePreview,
  FileScanRejectedError | FileScanFailedError
>;

export type PublicKnowledgeDependencies = {
  renderPreview?: typeof renderTemplatePreview;
  scan?: typeof scanUpload;
};

export const createPublicKnowledgeEndpoints = (
  catalogue: () => TemplatePackCatalogue,
  {
    renderPreview = renderTemplatePreview,
    scan = scanUpload,
  }: PublicKnowledgeDependencies = {},
) => {
  // Keyed by manifest hash: each bundled template is scanned and rendered
  // once per process. A rejecting verdict stays cached, since the same
  // hash-verified bytes would be rejected again; a scanner or render failure
  // is evicted, so the next request retries.
  const previewCache = new Map<string, Promise<PreviewOutcome>>();
  const publicPack = (packId: string) => {
    const pack = catalogue().get(packId);
    return pack?.publicDisplay ? pack : null;
  };
  const findPublicPack = (
    packId: string,
  ): Result<GeneratedTemplatePack, HandlerError> => {
    const pack = publicPack(packId);
    return pack ? Result.ok(pack) : notFound();
  };
  const findPublicTemplate = ({
    packId,
    templateId,
  }: {
    packId: string;
    templateId: string;
  }): Result<GeneratedTemplatePack["templates"][number], HandlerError> => {
    const template = publicPack(packId)?.templates.find(
      (item) => item.slug === templateId,
    );
    return template ? Result.ok(template) : notFound();
  };

  const listPacks = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        listPacksResponseSchema,
      ),
    },
    async function* () {
      const packs = yield* fromBundle(Result.ok(catalogue().list()));
      return Result.ok({
        items: packs.filter((pack) => pack.publicDisplay).map(packMetadata),
      });
    },
  );

  const readPack = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: packParams,
      response: safePublicHandlerResponseSchemasWithStatusText(
        readPackResponseSchema,
      ),
    },
    async function* ({ params }) {
      const pack = yield* fromBundle(findPublicPack(params.packId));
      return Result.ok({
        ...packMetadata(pack),
        templates: pack.templates.map(templateMetadata),
      });
    },
  );

  const readTemplate = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: templateParams,
      response: safePublicHandlerResponseSchemasWithStatusText(
        templateMetadataResponseSchema,
      ),
    },
    async function* ({ params }) {
      const template = yield* fromBundle(findPublicTemplate(params));
      return Result.ok(templateMetadata(template));
    },
  );

  const readTemplatePreview = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: templateParams,
      response: safePublicHandlerResponseSchemasWithStatusText(
        readTemplatePreviewResponseSchema,
      ),
    },
    async function* ({ params }) {
      const pack = publicPack(params.packId);
      const template = pack?.templates.find(
        (item) => item.slug === params.templateId,
      );
      if (!template) {
        return notFound();
      }

      let pending = previewCache.get(template.sha256);
      if (!pending) {
        const docx = await catalogue().readTemplateDocx({
          packId: params.packId,
          slug: params.templateId,
        });
        // The manifest advertises this template, so missing or mismatched
        // bytes are a deployment fault, not an unknown template.
        if (Result.isError(docx)) {
          return previewUnavailable(docx.error);
        }
        pending = previewCache.get(template.sha256);
        if (!pending) {
          const { bytes, fileName } = docx.value;
          // Bundled bytes reach the parsers the way server-built output
          // does: through the same security scan as an upload.
          const build = async (): Promise<PreviewOutcome> => {
            const scanned = await scan({
              bytes,
              declaredMimeType: DOCX_MIME_TYPE,
              fileName,
            });
            if (Result.isError(scanned)) {
              return Result.err(scanned.error);
            }
            return Result.ok(await renderPreview(scanned.value));
          };
          const built = build();
          previewCache.set(template.sha256, built);
          if (previewCache.size > MAX_CACHED_PREVIEWS) {
            const oldest = previewCache.keys().next().value;
            if (oldest !== undefined) {
              previewCache.delete(oldest);
            }
          }
          pending = built;
        }
      }
      const settled = await Result.tryPromise(async () => await pending);
      const retryable =
        Result.isError(settled) ||
        (Result.isError(settled.value) &&
          FileScanFailedError.is(settled.value.error));
      if (retryable && previewCache.get(template.sha256) === pending) {
        previewCache.delete(template.sha256);
      }
      const outcome = yield* settled;
      if (Result.isError(outcome)) {
        return previewUnavailable(outcome.error);
      }
      return Result.ok(outcome.value);
    },
  );

  const starterMetadata = (starter: (typeof STARTER_PLAYBOOKS)[number]) => ({
    id: starter.starterId,
    name: starter.name,
    description: starter.description,
    documentTypeKey: starter.documentTypeKey,
    positionCount: starter.positions.items.length,
  });

  const listStarters = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        listStartersResponseSchema,
      ),
    },
    async function* () {
      const starters = yield* fromBundle(Result.ok(STARTER_PLAYBOOKS));
      return Result.ok({ items: starters.map(starterMetadata) });
    },
  );

  const readStarter = createSafePublicHandler(
    {
      contract: "patch",
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: starterParams,
      response: safePublicHandlerResponseSchemasWithStatusText(
        readStarterResponseSchema,
      ),
    },
    async function* ({ params }) {
      const starter = yield* fromBundle(findStarter(params.id));
      return Result.ok({
        ...starterMetadata(starter),
        positions: starter.positions,
      });
    },
  );

  return {
    listPacks,
    readPack,
    readTemplate,
    readTemplatePreview,
    listStarters,
    readStarter,
  };
};
