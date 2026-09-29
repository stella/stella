import Elysia from "elysia";

import {
  createBundledTemplatePackCatalogue,
  type TemplatePackCatalogue,
} from "@stll/template-packs";

import { env } from "@/api/env";
import { createPublicKnowledgeEndpoints } from "@/api/handlers/public-knowledge/endpoints";

export const createPublicKnowledgeRoute = (
  catalogue: () => TemplatePackCatalogue,
) => {
  const {
    listPacks,
    readPack,
    readTemplate,
    readTemplatePreview,
    listStarters,
    readStarter,
  } = createPublicKnowledgeEndpoints(catalogue);
  return new Elysia({ prefix: "/public/knowledge" })
    .onBeforeHandle(({ set }) => {
      if (!env.FEATURE_PUBLIC_KNOWLEDGE) {
        set.status = 404;
        return { error: "Not Found" } as const;
      }
      set.headers["cache-control"] = "public, max-age=300";
    })
    .get("/template-packs", listPacks.handler)
    .get("/template-packs/:packId", readPack.handler, {
      params: readPack.config.params,
    })
    .get(
      "/template-packs/:packId/templates/:templateId",
      readTemplate.handler,
      {
        params: readTemplate.config.params,
      },
    )
    .get(
      "/template-packs/:packId/templates/:templateId/preview",
      readTemplatePreview.handler,
      {
        params: readTemplatePreview.config.params,
      },
    )
    .get("/playbook-starters", listStarters.handler)
    .get("/playbook-starters/:id", readStarter.handler, {
      params: readStarter.config.params,
    });
};

export const publicKnowledgeRoute = createPublicKnowledgeRoute(() =>
  createBundledTemplatePackCatalogue(env.TEMPLATE_PACKS_CONTENT_DIR),
);
