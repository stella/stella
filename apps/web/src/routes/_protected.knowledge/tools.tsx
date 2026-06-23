import { lazy, Suspense } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { subscribeToMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { ensureRouteQueryData } from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import type { CatalogueBrowserFilterKind } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
import type { ToolDetailPayload } from "@/routes/_protected.knowledge/-components/catalogue/tool-detail-view";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/routes/_protected.knowledge/-queries/catalogue";
import { organizationSettingsOptions } from "@/routes/_protected.organization/-settings-queries";

const LazyCatalogueBrowser = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/catalogue-browser");
  return { default: module.CatalogueBrowser };
});

const LazyToolDetailView = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailView };
});

const LazyToolDetailRailIcon = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/tool-detail-view");
  return { default: module.ToolDetailRailIcon };
});

// Tool-detail tabs live next to a route; they auto-close when the
// user navigates away from `/knowledge/tools` so the rail doesn't
// keep stale entries for a page the user has left.
registerInspectorView<ToolDetailPayload>({
  type: "tool-detail",
  render: ToolDetailViewRenderer,
  railIcon: ToolDetailRailIconRenderer,
  navigationPolicy: "close-on-route-leave",
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
});

// Per-tab flag so we POST /skills/seed at most once per browser
// session. The handler itself is idempotent (returns early when any
// slash-command skill already exists for the user), but a wasted
// round trip on every Tools navigation still hurts; this gates it
// to the first visit.
const seededThisSession = new Set<string>();

export const Route = createFileRoute("/_protected/knowledge/tools")({
  validateSearch: searchSchema,
  // Seed default slash-command skills on first Tools visit per
  // session. Used to live on the standalone Prompts page, which no
  // longer exists.
  loader: async ({ context }) => {
    const orgId = context.user.activeOrganizationId;

    if (!seededThisSession.has(orgId)) {
      const response = await api.skills.seed.post({ queryKey: ["skills"] });
      // Only mark the org as seeded once the server confirmed — a
      // transient failure would otherwise pin us into the "already
      // seeded" branch for the rest of the session and the user would
      // never get default slash commands without a full reload.
      if (!response.error) {
        seededThisSession.add(orgId);
        // When the server actually wrote rows, invalidate the local
        // skill/catalogue caches so chat (slash menu) and any open Tools
        // browser pick the new commands up immediately instead of waiting
        // for staleTime to lapse. Both queries are keyed by org id.
        if (response.data.seeded) {
          await Promise.all([
            context.queryClient.invalidateQueries({
              queryKey: knowledgeKeys.skills.all(orgId),
            }),
            context.queryClient.invalidateQueries({
              queryKey: catalogueKeys.all(orgId),
            }),
          ]);
        }
      }
    }

    await Promise.all([
      ensureRouteQueryData(context.queryClient, catalogueOptions(orgId)),
      ensureRouteQueryData(
        context.queryClient,
        organizationSettingsOptions(orgId),
      ),
      // CatalogueBrowser reads the member role via a non-suspense useQuery; seed
      // it here so it is a synchronous cache hit on mount. Otherwise a cold-cache
      // fetch resolving mid-mount notifies the not-yet-mounted fiber (React
      // "state update on a component that hasn't mounted yet"), which flaked the
      // route-smoke e2e on /knowledge/skills (and its twin /knowledge/prompts).
      ensureRouteQueryData(context.queryClient, roleOptions),
    ]);
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
      <ToolsPageHeader />
      <Suspense fallback={<ToolsCatalogueSkeleton />}>
        <ToolsCatalogue
          initialKind={initialKind}
          key={initialKind ?? "all"}
          organizationId={organizationId}
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

// The route's `loader` (skills.seed POST) blocks the first visit, so without a
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

type ToolsCatalogueProps = {
  initialKind: CatalogueBrowserFilterKind | undefined;
  organizationId: string;
};

function ToolsCatalogue({ initialKind, organizationId }: ToolsCatalogueProps) {
  const { data: settings } = useSuspenseQuery(
    organizationSettingsOptions(organizationId),
  );
  const { data: role } = useSuspenseQuery(roleOptions);
  // Match the backend gate: only admins/owners can create MCP connectors
  // (see `POST /mcp/connectors`). Members would see the form open and
  // the submit 403, so hide the affordance entirely.
  const canManageCustomTools = role === "admin" || role === "owner";

  return (
    <LazyCatalogueBrowser
      canManageCustomTools={canManageCustomTools}
      initialKind={initialKind}
      organizationId={organizationId}
      practiceJurisdictions={settings.practiceJurisdictions}
    />
  );
}
