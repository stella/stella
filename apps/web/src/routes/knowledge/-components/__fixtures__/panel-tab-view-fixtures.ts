import "@/routes/knowledge/-components/template-studio-inspector";
import "@/routes/knowledge/tools";

import type { GenericTab } from "@/components/inspector/inspector-store-types";
import type { ToolDetailPayload } from "@/routes/knowledge/-components/catalogue/tool-detail-view";
import { TEMPLATE_STUDIO_VIEW } from "@/routes/knowledge/-components/template-studio-constants";
import type { TemplateStudioPayload } from "@/routes/knowledge/-components/template-studio-inspector";

const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";

export const warmKnowledgePanelViewRenderers = async () => {
  await import("@/routes/knowledge/-components/catalogue/tool-detail-view");
};

export const knowledgePanelFixtures = [
  {
    type: "view",
    viewType: TEMPLATE_STUDIO_VIEW,
    id: `template:${FIXTURE_ID}`,
    label: "Engagement template",
    payload: { templateId: FIXTURE_ID } satisfies TemplateStudioPayload,
  },
  {
    type: "view",
    viewType: "tool-detail",
    id: `tool:${FIXTURE_ID}`,
    label: "Legal research",
    payload: {
      kind: "skill",
      slug: "legal-research",
      organizationId: FIXTURE_ID,
      iconHint: { icon: null, iconUrl: null },
    } satisfies ToolDetailPayload,
  },
] as const satisfies readonly GenericTab[];
