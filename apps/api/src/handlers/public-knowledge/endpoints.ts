import { Result } from "better-result";
import { t } from "elysia";

import type { TemplatePackCatalogue } from "@stll/template-packs";
import type { GeneratedTemplatePack } from "@stll/template-packs/schema";

import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { renderTemplatePreview } from "@/api/lib/docx/render-template-preview";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  findStarterPlaybook,
  STARTER_PLAYBOOKS,
} from "@/api/lib/knowledge/starter-playbooks";

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

const MAX_CACHED_PREVIEWS = 64;

export const createPublicKnowledgeEndpoints = (
  catalogue: () => TemplatePackCatalogue,
  renderPreview: typeof renderTemplatePreview = renderTemplatePreview,
) => {
  const previewCache = new Map<
    string,
    ReturnType<typeof renderTemplatePreview>
  >();
  const publicPack = (packId: string) => {
    const pack = catalogue().get(packId);
    return pack?.publicDisplay ? pack : null;
  };

  const listPacks = createSafePublicHandler(
    { mcp: { type: "internal", reason: "public_indexing" } },
    // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers use async generators.
    async function* () {
      return Result.ok({
        items: catalogue()
          .list()
          .filter((pack) => pack.publicDisplay)
          .map(packMetadata),
      });
    },
  );

  const readPack = createSafePublicHandler(
    {
      mcp: { type: "internal", reason: "public_indexing" },
      params: packParams,
    },
    // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers use async generators.
    async function* ({ params }) {
      const pack = publicPack(params.packId);
      if (!pack) {
        return notFound();
      }
      return Result.ok({
        ...packMetadata(pack),
        templates: pack.templates.map(templateMetadata),
      });
    },
  );

  const readTemplate = createSafePublicHandler(
    {
      mcp: { type: "internal", reason: "public_indexing" },
      params: templateParams,
    },
    // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers use async generators.
    async function* ({ params }) {
      const template = publicPack(params.packId)?.templates.find(
        (item) => item.slug === params.templateId,
      );
      if (!template) {
        return notFound();
      }
      return Result.ok(templateMetadata(template));
    },
  );

  const readTemplatePreview = createSafePublicHandler(
    {
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
        if (Result.isError(docx)) {
          return notFound();
        }
        pending = previewCache.get(template.sha256);
        if (!pending) {
          const render = Promise.resolve().then(() =>
            renderPreview(docx.value.bytes),
          );
          previewCache.set(template.sha256, render);
          if (previewCache.size > MAX_CACHED_PREVIEWS) {
            const oldest = previewCache.keys().next().value;
            if (oldest !== undefined) {
              previewCache.delete(oldest);
            }
          }
          pending = render;
        }
      }
      const outcome = await Result.tryPromise(async () => await pending);
      if (
        Result.isError(outcome) &&
        previewCache.get(template.sha256) === pending
      ) {
        previewCache.delete(template.sha256);
      }
      const preview = yield* outcome;
      return Result.ok(preview);
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
    { mcp: { type: "internal", reason: "public_indexing" } },
    // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers use async generators.
    async function* () {
      return Result.ok({ items: STARTER_PLAYBOOKS.map(starterMetadata) });
    },
  );

  const readStarter = createSafePublicHandler(
    {
      mcp: { type: "internal", reason: "public_indexing" },
      params: starterParams,
    },
    // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers use async generators.
    async function* ({ params }) {
      const starter = findStarterPlaybook(params.id);
      if (!starter) {
        return notFound();
      }
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
