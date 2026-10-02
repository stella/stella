import { lazy, Suspense } from "react";

import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  ToolsCatalogueSkeleton,
  ToolsPageHeader,
} from "@/features/knowledge/views/tools/tools-page-chrome";
import { getTranslator } from "@/i18n/i18n-store";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import type { ToolDetailPayload } from "@/routes/knowledge/-components/catalogue/tool-detail-view";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicToolsCatalogue } from "@/routes/knowledge/-public/public-tools-catalogue";

const LazyToolDetailView = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailView };
});

const LazyMemberToolsPage = lazy(async () => {
  const module = await import("@/routes/knowledge/-member/member-tools-page");
  return { default: module.MemberToolsPage };
});

const LazyToolDetailRailIcon = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailRailIcon };
});

// Tool-detail tabs live next to a route; they auto-close when the
// user navigates away from `/knowledge/tools` so the rail doesn't
// keep stale entries for a page the user has left.
const isToolDetailPayload = (value: unknown): value is ToolDetailPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("kind" in value) ||
    !("slug" in value) ||
    !("organizationId" in value) ||
    !("iconHint" in value)
  ) {
    return false;
  }
  if (
    value.kind !== "skill" &&
    value.kind !== "mcp" &&
    value.kind !== "native-tool"
  ) {
    return false;
  }
  if (
    typeof value.slug !== "string" ||
    typeof value.organizationId !== "string"
  ) {
    return false;
  }
  const iconHint = value.iconHint;
  if (typeof iconHint !== "object" || iconHint === null) {
    return false;
  }
  return (
    "icon" in iconHint &&
    (iconHint.icon === null || typeof iconHint.icon === "string") &&
    "iconUrl" in iconHint &&
    (iconHint.iconUrl === null || typeof iconHint.iconUrl === "string")
  );
};

registerInspectorView<ToolDetailPayload>({
  type: "tool-detail",
  render: ToolDetailViewRenderer,
  railIcon: ToolDetailRailIconRenderer,
  validate: isToolDetailPayload,
});

function ToolDetailViewRenderer(
  props: InspectorViewRenderProps<ToolDetailPayload>,
) {
  return (
    <Suspense fallback={null}>
      <LazyToolDetailView {...props} />
    </Suspense>
  );
}

function ToolDetailRailIconRenderer(
  props: InspectorRailIconProps<ToolDetailPayload>,
) {
  return (
    <Suspense fallback={null}>
      <LazyToolDetailRailIcon {...props} />
    </Suspense>
  );
}

const KIND_VALUES = ["all", "skill", "mcp"] as const;

const searchSchema = v.object({
  kind: v.optional(v.picklist(KIND_VALUES)),
  /** Catalogue slug to open on load, e.g. `?slug=krs` from an API refusal that
   *  names where the tool is enabled. */
  slug: v.optional(v.string()),
});

export const Route = createFileRoute("/knowledge/tools")({
  validateSearch: searchSchema,
  head: () =>
    createPublicToolsHead({
      description: getTranslator()("publicTools.metaDescription"),
      path: "/knowledge/tools",
      title: pageTitle("knowledge.sections.tools.title"),
      type: "website",
    }),
  component: ToolsSection,
});

function ToolsSection() {
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicToolsCatalogue />}
      checking={<ToolsPagePending />}
      member={(organizationId) => (
        <Suspense fallback={<ToolsPagePending />}>
          <LazyMemberToolsPage organizationId={organizationId} />
        </Suspense>
      )}
    />
  );
}

// The catalogue page's own chrome with a catalogue skeleton, so the page stays
// put while the visitor is resolved and the catalogue loads.
function ToolsPagePending() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <ToolsPageHeader />
      <ToolsCatalogueSkeleton />
    </div>
  );
}
