import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
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
import { stellaToast } from "@stll/ui/toast";

import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { McpAuthorizationReview } from "@/components/mcp-authorization-review";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  isEffectivelyInstalled,
  type CatalogueMcp,
} from "@/lib/knowledge/catalogue-types";
import {
  mcpConnectorsOptions,
  mcpConnectionsOptions,
  type McpConnectorsResponse,
} from "@/lib/knowledge/queries";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";

import {
  canApproveIntegrationAuthorization,
  integrationStatus,
  matchesConnectionQuery,
  type IntegrationAuthorizationStatus,
  type IntegrationConnection,
} from "./connections.logic";

export type IntegrationsData = {
  /** Every integration the organization added. */
  installed: readonly CatalogueMcp[];
  /** The ones matching the search query. */
  visible: readonly CatalogueMcp[];
  connectionBySlug: ReadonlyMap<string, IntegrationConnection>;
  authorizationStatusBySlug: ReadonlyMap<
    string,
    IntegrationAuthorizationStatus
  >;
  authorizationReviewBySlug: ReadonlyMap<
    string,
    McpConnectorsResponse["connectors"][number]["authorizationReview"]
  >;
};

export const useIntegrations = (query: string): IntegrationsData => {
  const { id: userId, activeOrganizationId } = useAuthenticatedUser();
  const { data: catalogue } = useSuspenseQuery(
    catalogueOptions(activeOrganizationId, userId),
  );
  const { data: connectionsData } = useSuspenseQuery(
    mcpConnectionsOptions(activeOrganizationId, userId),
  );
  const { data: connectorsData } = useSuspenseQuery(
    mcpConnectorsOptions(activeOrganizationId),
  );

  const connectionBySlug = new Map<string, IntegrationConnection>(
    connectionsData.connections.map((connection) => [
      connection.connectorSlug,
      connection,
    ]),
  );
  const installed = catalogue.entries
    .filter((entry) => entry.kind === "mcp")
    .filter((entry) => isEffectivelyInstalled(entry));
  const visible = installed.filter((entry) =>
    matchesConnectionQuery(query, [entry.displayName, entry.description]),
  );
  const authorizationStatusBySlug = new Map(
    connectorsData.connectors.map((connector) => [
      connector.slug,
      connector.authorizationStatus,
    ]),
  );
  const authorizationReviewBySlug = new Map(
    connectorsData.connectors.map((connector) => [
      connector.slug,
      connector.authorizationReview,
    ]),
  );
  return {
    installed,
    visible,
    connectionBySlug,
    authorizationStatusBySlug,
    authorizationReviewBySlug,
  };
};

/**
 * Integrations the organization added (MCP servers the AI calls in chat), with
 * this user's sign-in state. Browsing and adding stays in Tools; each row opens
 * its entry there.
 */
export const IntegrationsGroup = ({
  integrations: {
    installed,
    visible,
    connectionBySlug,
    authorizationStatusBySlug,
    authorizationReviewBySlug,
  },
}: {
  integrations: IntegrationsData;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const canManageOrganizationSettings = usePermissions({
    organizationSettings: ["update"],
  });

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
          const connectorSlug = entry.installedConnectorSlug ?? entry.slug;
          const review = authorizationReviewBySlug.get(connectorSlug);
          const canApprove =
            canApproveIntegrationAuthorization(
              canManageOrganizationSettings,
              authorizationStatusBySlug.get(connectorSlug),
            ) &&
            review !== undefined &&
            review !== null &&
            review.issuer !== null;
          const status = integrationStatus({
            authType: entry.authType,
            authorizationStatus: authorizationStatusBySlug.get(connectorSlug),
            connection: connectionBySlug.get(connectorSlug),
          });
          return (
            <ListItem
              key={entry.slug}
              render={
                canApprove ? undefined : (
                  <Link search={{ slug: entry.slug }} to="/knowledge/tools" />
                )
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
                  {canApprove ? (
                    <Link search={{ slug: entry.slug }} to="/knowledge/tools">
                      <BidiText>{entry.displayName}</BidiText>
                    </Link>
                  ) : (
                    <BidiText>{entry.displayName}</BidiText>
                  )}
                </ListItemTitle>
                {entry.description.length > 0 && (
                  <ListItemDescription>{entry.description}</ListItemDescription>
                )}
              </ListItemContent>
              <ListItemActions>
                {canApprove &&
                  review !== undefined &&
                  review !== null &&
                  review.issuer !== null && (
                    <ApproveAuthorizationButton
                      connectorSlug={connectorSlug}
                      issuer={review.issuer}
                      endpointOrigins={review.endpointOrigins}
                    />
                  )}
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

const ApproveAuthorizationButton = ({
  connectorSlug,
  issuer,
  endpointOrigins,
}: {
  connectorSlug: string;
  issuer: string;
  endpointOrigins: string[];
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const approve = useMutation({
    mutationFn: async () =>
      unwrapEden(
        await api.mcp
          .connectors({ slug: connectorSlug })
          ["approve-authorization"].post({
            confirmedIssuer: issuer,
            confirmedEndpointOrigins: endpointOrigins,
          }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: mcpConnectorsOptions(activeOrganizationId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: mcpConnectionsOptions(activeOrganizationId, userId)
            .queryKey,
        }),
      ]);
      setOpen(false);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        {t("common.approve")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("common.approve")}</DialogTitle>
        </DialogHeader>
        <McpAuthorizationReview
          issuer={issuer}
          endpointOrigins={endpointOrigins}
        />
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
            size="xs"
            variant="outline"
          >
            {t("common.approve")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
