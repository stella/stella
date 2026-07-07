import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";

import { env } from "@/env";
import { CliCard } from "@/routes/_protected.settings/-components/account/cli-card";
import {
  ConnectedAppsCard,
  ConnectedAppsCardSkeleton,
} from "@/routes/_protected.settings/-components/account/connected-apps-card";
import { McpServerCard } from "@/routes/_protected.settings/-components/account/mcp-server-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/account/connections",
)({
  component: ConnectionsPage,
  pendingComponent: ConnectionsPagePending,
});

function ConnectionsPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.connections.description")}
        title={t("settings.connections.title")}
      />
      <McpServerCard apiOrigin={env.VITE_API_URL} />
      <CliCard apiOrigin={env.VITE_API_URL} />
      <ConnectedAppsCard />
    </>
  );
}

// Mirrors the real page (header, MCP + CLI cards render instantly since
// they only depend on `env`, only the connected-apps table needs a
// skeleton) so the page does not jump once the query resolves.
function ConnectionsPagePending() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>
      <McpServerCard apiOrigin={env.VITE_API_URL} />
      <CliCard apiOrigin={env.VITE_API_URL} />
      <ConnectedAppsCardSkeleton />
    </>
  );
}
