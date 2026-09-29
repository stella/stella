import { lazy, Suspense } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { stellaToast } from "@stll/ui/toast";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import {
  ToolsCatalogueSkeleton,
  ToolsPageHeader,
} from "@/features/knowledge/views/tools/tools-page-chrome";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/lib/knowledge/queries/catalogue";
import { subscribeToMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import type { CatalogueBrowserFilterKind } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import type { ToolDetailPayload } from "@/routes/_protected.knowledge/-components/catalogue/tool-detail-view";

const LazyToolDetailView = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailView };
});

const LazyCatalogueBrowser = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/catalogue-browser");
  return { default: module.CatalogueBrowserWithRouteData };
});

const LazyToolDetailRailIcon = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/tool-detail-view");
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

export const Route = createFileRoute("/_protected/knowledge/tools")({
  validateSearch: searchSchema,
  loader: async ({ context }) => {
    const orgId = context.user.activeOrganizationId;
    const [, settings, role] = await Promise.all([
      ensureRouteQueryData(context.queryClient, catalogueOptions(orgId)),
      ensureRouteQueryData(
        context.queryClient,
        organizationSettingsOptions(orgId),
      ),
      // CatalogueBrowser reads the member role via a non-suspense useQuery; seed
      // it here so it is a synchronous cache hit on mount. Otherwise a cold-cache
      // fetch resolving mid-mount notifies the not-yet-mounted fiber (React
      // "state update on a component that hasn't mounted yet"), which flaked the
      // route-smoke e2e.
      ensureRouteQueryData(context.queryClient, roleOptions),
    ]);

    return {
      canCreateSkills: authClient.organization.checkRolePermission({
        permissions: { agentSkill: ["create"] },
        role,
      }),
      canManageCustomTools: role === "admin" || role === "owner",
      practiceJurisdictions: settings.practiceJurisdictions,
    };
  },
  component: ToolsPage,
  pendingComponent: ToolsPagePending,
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
  const initialSlug = Route.useSearch({
    select: (s): string | undefined => s.slug,
  });
  const routeData = Route.useLoaderData({
    select: ({
      canCreateSkills,
      canManageCustomTools,
      practiceJurisdictions,
    }) => ({
      canCreateSkills,
      canManageCustomTools,
      practiceJurisdictions,
    }),
  });

  // OAuth completion lands in a popup tab/window; the popup
  // broadcasts via BroadcastChannel (falling back to opener
  // postMessage), so the catalogue page needs an active subscription
  // to surface the toast and refetch the catalogue.
  useExternalSyncEffect(
    () =>
      subscribeToMcpOAuthOutcome((outcome) => {
        if (outcome.status === "connected") {
          stellaToast.add({
            title: t("knowledge.mcp.connectedToast"),
            type: "success",
          });
          detached(
            queryClient.invalidateQueries({
              queryKey: catalogueKeys.list(organizationId),
            }),
            "knowledge-tools.invalidate",
          );
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
      <ToolsPageHeader />
      <Suspense fallback={<ToolsCatalogueSkeleton />}>
        <LazyCatalogueBrowser
          canCreateSkills={routeData.canCreateSkills}
          canManageCustomTools={routeData.canManageCustomTools}
          initialKind={initialKind}
          initialSlug={initialSlug}
          // The browser reads both search params once, on mount, so a link that
          // changes either one remounts it rather than leaving the previous
          // filter or detail panel in place.
          key={`${initialKind ?? "all"}:${initialSlug ?? ""}`}
          organizationId={organizationId}
          practiceJurisdictions={routeData.practiceJurisdictions}
        />
      </Suspense>
    </div>
  );
}

// The route's `loader` waits for the catalogue and settings, so without a
// pendingComponent it flashes the glowing logo before the catalogue skeleton.
// Render the real chrome + catalogue skeleton during route-pending as well.
function ToolsPagePending() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <ToolsPageHeader />
      <ToolsCatalogueSkeleton />
    </div>
  );
}
