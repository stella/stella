import { Result } from "better-result";
import { t } from "elysia";

import type { TemplatePackCatalogue } from "@stll/template-packs";
import type { GeneratedTemplatePack } from "@stll/template-packs/schema";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
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

const packParams = t.Object({
  packId: t.String({ minLength: 1, maxLength: 64 }),
});
const templateParams = t.Object({
  packId: t.String({ minLength: 1, maxLength: 64 }),
  templateId: t.String({ minLength: 1, maxLength: 64 }),
});
const starterParams = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
});

const previewUnavailable = (cause: unknown) =>
  Result.err(
    new HandlerError({ status: 503, message: "Preview unavailable", cause }),
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
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
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
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: packParams,
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
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: templateParams,
    },
    async function* ({ params }) {
      const template = yield* fromBundle(findPublicTemplate(params));
      return Result.ok(templateMetadata(template));
    },
  );

  const readTemplatePreview = createSafePublicHandler(
    {
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: templateParams,
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
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
    },
    async function* () {
      const starters = yield* fromBundle(Result.ok(STARTER_PLAYBOOKS));
      return Result.ok({ items: starters.map(starterMetadata) });
    },
  );

  const readStarter = createSafePublicHandler(
    {
      cache: { kind: "public", maxAge: 300 },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: starterParams,
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
