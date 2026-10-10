import Elysia from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import {
  createBundledTemplatePackCatalogue,
  type TemplatePackCatalogue,
} from "@stll/template-packs";

import { env } from "@/api/env";
import { createPublicKnowledgeEndpoints } from "@/api/handlers/public-knowledge/endpoints";
import type { PublicKnowledgeDependencies } from "@/api/handlers/public-knowledge/endpoints";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { setSecurityHeaders } from "@/api/lib/security-headers";

let bundledCatalogue: TemplatePackCatalogue | null = null;

const PUBLIC_KNOWLEDGE_PATH = "/public/knowledge";
const VERSIONED_PUBLIC_KNOWLEDGE_PATH = `${STELLA_API_VERSION_PREFIX}${PUBLIC_KNOWLEDGE_PATH}`;
const isPublicKnowledgePath = (path: string) =>
  path === PUBLIC_KNOWLEDGE_PATH ||
  path.startsWith(`${PUBLIC_KNOWLEDGE_PATH}/`) ||
  path === VERSIONED_PUBLIC_KNOWLEDGE_PATH ||
  path.startsWith(`${VERSIONED_PUBLIC_KNOWLEDGE_PATH}/`);

export const createPublicKnowledgeRoute = (
  catalogue: () => TemplatePackCatalogue,
  dependencies?: PublicKnowledgeDependencies,
) => {
  const {
    listPacks,
    readPack,
    readTemplate,
    readTemplatePreview,
    listStarters,
    readStarter,
  } = createPublicKnowledgeEndpoints(catalogue, dependencies);
  return new Elysia({ prefix: PUBLIC_KNOWLEDGE_PATH })
    .onRequest(({ set }) => {
      setSecurityHeaders(set);
    })
    .onBeforeHandle(({ path, set }) => {
      if (
        isPublicKnowledgePath(path) &&
        !isDeploymentFeatureEnabled("FEATURE_PUBLIC_KNOWLEDGE")
      ) {
        set.status = 404;
        return { error: "Not Found" } as const;
      }
      return undefined;
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

export const publicKnowledgeRoute = createPublicKnowledgeRoute(
  () =>
    (bundledCatalogue ??= createBundledTemplatePackCatalogue(
      env.TEMPLATE_PACKS_CONTENT_DIR,
      { availability: "readable" },
    )),
);
