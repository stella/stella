import { Suspense, useEffect } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { stellaToast } from "@stll/ui/components/toast";

import { registerInspectorView } from "@/components/inspector/view-registry";
import { subscribeToMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { CatalogueBrowser } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import type { CatalogueBrowserFilterKind } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import {
  ToolDetailRailIcon,
  ToolDetailView,
  type ToolDetailPayload,
} from "@/routes/_protected.knowledge/-components/catalogue/tool-detail-view";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";
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
  const queryClient = useQueryClient();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const initialKind = Route.useSearch({
    select: (s): CatalogueBrowserFilterKind | undefined => s.kind,
  });

  // OAuth completion lands in a popup tab/window; the popup
  // broadcasts via BroadcastChannel (falling back to opener
  // postMessage), so the catalogue page needs an active subscription
  // to surface the toast and refetch the catalogue. The legacy
  // listener lived on /knowledge/mcp before the surface unified.
  useEffect(
    () =>
      subscribeToMcpOAuthOutcome((outcome) => {
        if (outcome.status === "connected") {
          stellaToast.add({
            title: t("knowledge.mcp.connectedToast"),
            type: "success",
          });
          void queryClient.invalidateQueries({
            queryKey: catalogueKeys.list(organizationId),
          });
          return;
        }
        stellaToast.add({
          title: t("knowledge.mcp.errorTitle"),
          description: t("knowledge.mcp.errorDescription"),
          type: "error",
        });
      }),
    [organizationId, queryClient, t],
  );

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
