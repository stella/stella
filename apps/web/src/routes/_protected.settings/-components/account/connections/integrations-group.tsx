import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import {
  List,
  ListEmpty,
  ListGroup,
  ListGroupAction,
  ListGroupCount,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";

import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { mcpConnectionsOptions } from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import {
  isEffectivelyInstalled,
  type CatalogueMcp,
} from "@/routes/knowledge/-components/catalogue/catalogue-types";

import {
  integrationStatus,
  matchesConnectionQuery,
  type IntegrationConnection,
} from "./connections.logic";

export type IntegrationsData = {
  /** Every integration the organization added. */
  installed: readonly CatalogueMcp[];
  /** The ones matching the search query. */
  visible: readonly CatalogueMcp[];
  connectionBySlug: ReadonlyMap<string, IntegrationConnection>;
};

export const useIntegrations = (query: string): IntegrationsData => {
  const { id: userId, activeOrganizationId } = useAuthenticatedUser();
  const { data: catalogue } = useSuspenseQuery(
    catalogueOptions(activeOrganizationId, userId),
  );
  const { data: connectionsData } = useSuspenseQuery(
    mcpConnectionsOptions(activeOrganizationId, userId),
  );

  const connectionBySlug = new Map<string, IntegrationConnection>(
    connectionsData.connections.map((connection) => [
      connection.connectorSlug,
      connection,
    ]),
  );
  const installed = catalogue.entries.filter(
    (entry): entry is CatalogueMcp =>
      entry.kind === "mcp" && isEffectivelyInstalled(entry),
  );
  const visible = installed.filter((entry) =>
    matchesConnectionQuery(query, [entry.displayName, entry.description]),
  );
  return { installed, visible, connectionBySlug };
};

/**
 * Integrations the organization added (MCP servers the AI calls in chat), with
 * this user's sign-in state. Browsing and adding stays in Tools; each row opens
 * its entry there.
 */
export const IntegrationsGroup = ({
  integrations: { installed, visible, connectionBySlug },
}: {
  integrations: IntegrationsData;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <ListGroup aria-labelledby="connections-integrations">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="connections-integrations">
            {t("settings.connections.integrationsTitle")}
            {installed.length > 0 && (
              <ListGroupCount>{format.number(visible.length)}</ListGroupCount>
            )}
          </ListGroupTitle>
          <ListGroupDescription>
            {t("settings.connections.integrationsDescription")}
          </ListGroupDescription>
        </ListGroupHeading>
        <ListGroupAction>
          <Button
            render={<Link search={{ kind: "mcp" }} to="/knowledge/tools" />}
            size="xs"
            variant="ghost"
          >
            {t("settings.connections.browseIntegrations")}
            <DirectionalIcon icon={ChevronRightIcon} />
          </Button>
        </ListGroupAction>
      </ListGroupHeader>
      <List>
        {visible.map((entry) => {
          const status = integrationStatus(
            entry.authType,
            connectionBySlug.get(entry.installedConnectorSlug ?? entry.slug),
          );
          return (
            <ListItem
              key={entry.slug}
              render={
                <Link search={{ slug: entry.slug }} to="/knowledge/tools" />
              }
            >
              <ListItemMedia>
                <CatalogueEntryIcon
                  className="text-muted-foreground"
                  icon={entry.icon}
                  iconUrl={entry.iconUrl ?? null}
                  size={18}
                  slug={entry.slug}
                />
              </ListItemMedia>
              <ListItemContent>
                <ListItemTitle>
                  <BidiText>{entry.displayName}</BidiText>
                </ListItemTitle>
                {entry.description.length > 0 && (
                  <ListItemDescription>{entry.description}</ListItemDescription>
                )}
              </ListItemContent>
              <ListItemActions>
                {status && (
                  <ListItemStatus tone={status.tone}>
                    {t(status.labelKey)}
                  </ListItemStatus>
                )}
                <DirectionalIcon
                  className="text-foreground-placeholder size-4"
                  icon={ChevronRightIcon}
                />
              </ListItemActions>
            </ListItem>
          );
        })}
        {installed.length === 0 && (
          <ListEmpty>
            <Link
              className="text-foreground underline-offset-4 hover:underline"
              search={{ kind: "mcp" }}
              to="/knowledge/tools"
            >
              {t("settings.connections.integrationsEmpty")}
            </Link>
          </ListEmpty>
        )}
      </List>
    </ListGroup>
  );
};
