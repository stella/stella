import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SearchXIcon } from "@stll/ui/icons";
import { SearchField } from "@stll/ui/search-field";

import { AssistantSetup } from "@/components/assistant-setup";
import { externalApiOrigin } from "@/lib/api-origins";
import { ConnectionsPageShell } from "@/routes/_protected.settings/-account.connections.pending";
import {
  AppsGroup,
  useConnectedApps,
} from "@/routes/_protected.settings/-components/account/connections/apps-group";
import { BrowserExtensionGroup } from "@/routes/_protected.settings/-components/account/connections/browser-extension-group";
import {
  BrowserSitesGroup,
  useBrowserSites,
} from "@/routes/_protected.settings/-components/account/connections/browser-sites-group";
import { ClientSetupGroups } from "@/routes/_protected.settings/-components/account/connections/client-setup-groups";
import {
  IntegrationsGroup,
  useIntegrations,
} from "@/routes/_protected.settings/-components/account/connections/integrations-group";
import {
  SharepointGroup,
  useSharepointConnectionRow,
} from "@/routes/_protected.settings/-components/account/connections/sharepoint-group";

/** The connections page: its shell (`ConnectionsPageShell`) with the lists. */
export function ConnectionsPage() {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const integrations = useIntegrations(trimmedQuery);
  const apps = useConnectedApps(trimmedQuery);
  const sites = useBrowserSites(trimmedQuery);
  const sharepoint = useSharepointConnectionRow(trimmedQuery);
  const showIntegrations = !isSearching || integrations.visible.length > 0;
  const showApps = !isSearching || apps.visible.length > 0;
  const showSites = sites.visible.length > 0;

  return (
    <ConnectionsPageShell
      search={
        <SearchField
          aria-label={t("settings.connections.searchPlaceholder")}
          clearLabel={t("common.clearSearch")}
          onValueChange={setQuery}
          placeholder={t("settings.connections.searchPlaceholder")}
          value={query}
        />
      }
    >
      {!isSearching && <AssistantSetup />}
      {showIntegrations && <IntegrationsGroup integrations={integrations} />}
      {sharepoint.visible && (
        <SharepointGroup access={sharepoint.access} state={sharepoint.state} />
      )}
      {showApps && <AppsGroup apps={apps} />}
      {!isSearching && <BrowserExtensionGroup />}
      {showSites && <BrowserSitesGroup sites={sites} />}
      {!isSearching && <ClientSetupGroups apiOrigin={externalApiOrigin()} />}
      {!showIntegrations && !showApps && !showSites && !sharepoint.visible && (
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
    </ConnectionsPageShell>
  );
}
