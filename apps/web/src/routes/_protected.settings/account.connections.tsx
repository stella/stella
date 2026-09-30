import { useState } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SearchXIcon } from "@stll/ui/icons";
import { List, ListGroup } from "@stll/ui/list";
import { SearchField } from "@stll/ui/search-field";
import { Skeleton } from "@stll/ui/skeleton";

import { AssistantSetup } from "@/components/assistant-setup";
import { externalApiOrigin } from "@/lib/api-origins";
import { mcpConnectionsOptions } from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  AppsGroup,
  useConnectedApps,
} from "@/routes/_protected.settings/-components/account/connections/apps-group";
import { ClientSetupGroups } from "@/routes/_protected.settings/-components/account/connections/client-setup-groups";
import {
  IntegrationsGroup,
  useIntegrations,
} from "@/routes/_protected.settings/-components/account/connections/integrations-group";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { connectedAppsOptions } from "@/routes/_protected.settings/-queries/connections";

export const Route = createFileRoute(
  "/_protected/settings/account/connections",
)({
  component: ConnectionsPage,
  loader: async ({ context }) => {
    // Prime every query the page suspends on so the fetches run in parallel
    // during navigation instead of one after another on mount.
    const organizationId = context.user.activeOrganizationId;
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        connectedAppsOptions(context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        catalogueOptions(organizationId, context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        mcpConnectionsOptions(organizationId, context.user.id),
      ),
    ]);
  },
  pendingComponent: ConnectionsPagePending,
});

function ConnectionsPage() {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const integrations = useIntegrations(trimmedQuery);
  const apps = useConnectedApps(trimmedQuery);
  const showIntegrations = !isSearching || integrations.visible.length > 0;
  const showApps = !isSearching || apps.visible.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <SettingsPageHeader
          description={t("settings.connections.description")}
          title={t("settings.connections.title")}
        />
        <SearchField
          aria-label={t("settings.connections.searchPlaceholder")}
          clearLabel={t("onboarding.catalogueClearSearch")}
          onValueChange={setQuery}
          placeholder={t("settings.connections.searchPlaceholder")}
          value={query}
        />
      </div>
      {!isSearching && <AssistantSetup />}
      {showIntegrations && <IntegrationsGroup integrations={integrations} />}
      {showApps && <AppsGroup apps={apps} />}
      {!isSearching && <ClientSetupGroups apiOrigin={externalApiOrigin()} />}
      {!showIntegrations && !showApps && (
        <div className="text-muted-foreground flex flex-col items-start gap-1 px-1 text-sm">
          <p className="text-foreground flex items-center gap-2">
            <SearchXIcon className="text-muted-foreground size-4" />
            {t("settings.connections.noMatches", { query: trimmedQuery })}
          </p>
          <Link
            className="underline-offset-4 hover:underline"
            search={{ kind: "mcp" }}
            to="/knowledge/tools"
          >
            {t("settings.connections.browseIntegrations")}
          </Link>
        </div>
      )}
    </div>
  );
}

const PENDING_GROUPS = [
  { key: "integrations", rows: ["a", "b"] },
  { key: "apps", rows: ["a", "b"] },
  { key: "mcp", rows: ["a", "b", "c"] },
] as const;

// Mirrors the real page: header, search, then list groups of fixed-height
// rows, so nothing shifts when the queries resolve.
function ConnectionsPagePending() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </header>
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
      {PENDING_GROUPS.map((group) => (
        <ListGroup key={group.key}>
          <div className="flex flex-col gap-1.5 px-1">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <List>
            {group.rows.map((row) => (
              <li className="flex min-h-14 items-center gap-3 px-4" key={row}>
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-36" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </div>
                <Skeleton className="h-6 w-20" />
              </li>
            ))}
          </List>
        </ListGroup>
      ))}
    </div>
  );
}
