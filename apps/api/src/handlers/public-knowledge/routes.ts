import {
  createBundledTemplatePackCatalogue,
  type TemplatePackCatalogue,
} from "@stll/template-packs";

import { env } from "@/api/env";
import { createPublicKnowledgeEndpoints } from "@/api/handlers/public-knowledge/endpoints";
import type { PublicKnowledgeDependencies } from "@/api/handlers/public-knowledge/endpoints";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

let bundledCatalogue: TemplatePackCatalogue | null = null;

const PUBLIC_KNOWLEDGE_PATH = "/public/knowledge";

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
  return routes(
    {
      "/template-packs": { GET: listPacks },
      "/template-packs/:packId": { GET: readPack },
      "/template-packs/:packId/templates/:templateId": { GET: readTemplate },
      "/template-packs/:packId/templates/:templateId/preview": {
        GET: readTemplatePreview,
      },
      "/playbook-starters": { GET: listStarters },
      "/playbook-starters/:id": { GET: readStarter },
    },
    {
      prefix: PUBLIC_KNOWLEDGE_PATH,
      middleware: [deploymentFeatureGate("FEATURE_PUBLIC_KNOWLEDGE")],
    },
  );
};

export const publicKnowledgeRoute = createPublicKnowledgeRoute(
  () =>
    (bundledCatalogue ??= createBundledTemplatePackCatalogue(
      env.TEMPLATE_PACKS_CONTENT_DIR,
      { availability: "readable" },
    )),
);
