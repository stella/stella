import { lazy, Suspense } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/lib/knowledge/queries/catalogue";
import { startSkillSeed } from "@/lib/knowledge/skill-seed";
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

    // Default slash-command skills are seeded on the first Tools visit; the
    // page renders without waiting for it.
    startSkillSeed({
      queryClient: context.queryClient,
      organizationId: orgId,
      seedSkills: async () => unwrapEden(await api.skills.seed.post({})),
    });

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
  // to surface the toast and refetch the catalogue. The legacy
  // listener lived on /knowledge/mcp before the surface unified.
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

const CATALOGUE_FILTER_KEYS = ["all", "skill", "mcp"];
const CATALOGUE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the CatalogueBrowser body (toolbar row, filter pills, then a
// stack of bordered entry cards) so the Tools page chrome stays put and
// only the catalogue values stream in.
function ToolsCatalogueSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>

      <div className="flex items-center gap-1.5">
        {CATALOGUE_FILTER_KEYS.map((key) => (
          <Skeleton className="h-6 w-14 rounded-md" key={key} />
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="mb-1 h-3 w-28" />
        {CATALOGUE_ROW_KEYS.map((key) => (
          <div
            className="flex items-start gap-3 rounded-lg border p-3"
            key={key}
          >
            <Skeleton className="mt-0.5 size-6 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex min-h-6 items-center gap-2">
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="h-3 w-3/4" />
              <div className="flex flex-wrap items-center gap-1.5">
                <Skeleton className="h-5 w-12 rounded-md" />
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ToolsPageHeader = () => {
  const t = useTranslations();
  return (
    <div className="mb-6 flex flex-col gap-1">
      <h1 className="text-foreground text-xl font-semibold">
        {t("knowledge.sections.tools.title")}
      </h1>
      <p className="text-muted-foreground text-sm">
        {t("knowledge.sections.tools.description")}
      </p>
    </div>
  );
};

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
