import { Suspense } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { registerInspectorView } from "@/components/inspector/view-registry";
import { CatalogueBrowser } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import type { CatalogueBrowserFilterKind } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import {
  ToolDetailRailIcon,
  ToolDetailView,
  type ToolDetailPayload,
} from "@/routes/_protected.knowledge/-components/catalogue/tool-detail-view";
import { organizationSettingsOptions } from "@/routes/_protected.organization/-settings-queries";

// Tool-detail tabs live next to a route; they auto-close when the
// user navigates away from `/knowledge/tools` so the rail doesn't
// keep stale entries for a page the user has left.
registerInspectorView<ToolDetailPayload>({
  type: "tool-detail",
  render: ToolDetailView,
  railIcon: ToolDetailRailIcon,
  navigationPolicy: "close-on-route-leave",
});

const KIND_VALUES = ["all", "skill", "mcp"] as const;

const searchSchema = v.object({
  kind: v.optional(v.picklist(KIND_VALUES)),
});

export const Route = createFileRoute("/_protected/knowledge/tools")({
  validateSearch: searchSchema,
  component: ToolsPage,
});

const protectedRouteApi = getRouteApi("/_protected");

function ToolsPage() {
  const t = useTranslations();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const initialKind = Route.useSearch({
    select: (s): CatalogueBrowserFilterKind | undefined => s.kind,
  });

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-foreground text-xl font-semibold">
          {t("knowledge.sections.tools.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("knowledge.sections.tools.description")}
        </p>
      </div>
      <Suspense fallback={null}>
        <ToolsCatalogue
          initialKind={initialKind}
          organizationId={organizationId}
        />
      </Suspense>
    </div>
  );
}

type ToolsCatalogueProps = {
  initialKind: CatalogueBrowserFilterKind | undefined;
  organizationId: string;
};

function ToolsCatalogue({ initialKind, organizationId }: ToolsCatalogueProps) {
  const { data: settings } = useSuspenseQuery(organizationSettingsOptions);
  return (
    <CatalogueBrowser
      initialKind={initialKind}
      organizationId={organizationId}
      practiceJurisdictions={settings.practiceJurisdictions}
    />
  );
}
