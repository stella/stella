import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  MICROSOFT365_CAPABILITIES,
  type Microsoft365Capability,
} from "@stll/api-contract/microsoft365";
import { Button } from "@stll/ui/button";
import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { sharepointConnectionOptions } from "@/routes/_protected.settings/-queries/connections";

import { SharepointConnectionActions } from "./sharepoint-connection-actions";

export const SharepointGroup = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { id: userId, activeOrganizationId: organizationId } =
    useAuthenticatedUser();
  const options = sharepointConnectionOptions({ organizationId, userId });
  const { data, error, refetch } = useQuery(options);
  const canManage = usePermissions({ organizationSettings: ["update"] });
  const onError = (failure: unknown) => {
    notifyUserError(failure, t("errors.actionFailed"));
    analytics.captureError(failure, {
      fingerprintKey: "SharepointGroup:failure",
      scope: { type: "handler", handlerId: "SharepointGroup:failure" },
    });
  };
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: options.queryKey });
  };
  const connect = useMutation({
    mutationFn: async (capability: Microsoft365Capability) =>
      unwrapApiResponse(
        await api.sharepoint.connect.post({ capabilities: [capability] }),
      ),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError,
  });
  const updateCapabilities = useMutation({
    mutationFn: async (capabilities: Microsoft365Capability[]) =>
      unwrapApiResponse(
        await api.sharepoint.capabilities.put({ capabilities }),
      ),
    onSuccess: invalidate,
    onError,
  });
  const disable = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await api.sharepoint.enablement.put({ enabled: false }),
      ),
    onSuccess: invalidate,
    onError,
  });
  const disconnect = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(await api.sharepoint.connection.delete()),
    onSuccess: invalidate,
    onError,
  });

  if (error && !(APIError.is(error) && error.status === 404)) {
    return (
      <RecoverableErrorStatus
        className="flex items-center gap-2"
        message={t("settings.connections.microsoft365Error")}
        actions={
          <Button
            onClick={() => detached(refetch(), "sharepoint-connection.retry")}
            size="sm"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  if (!data) {
    return null;
  }
  if (data.type === "upgrade_required") {
    return (
      <ListGroup aria-labelledby="microsoft365-heading">
        <ListGroupHeader>
          <ListGroupHeading>
            <ListGroupTitle id="microsoft365-heading">
              {t("settings.connections.microsoft365Title")}
            </ListGroupTitle>
          </ListGroupHeading>
        </ListGroupHeader>
        <RecoverableErrorStatus
          className="flex items-center gap-2"
          message={t("settings.connections.microsoft365Error")}
          actions={
            <Button
              onClick={() =>
                detached(invalidate(), "sharepoint-connection.upgrade-retry")
              }
              size="sm"
              variant="outline"
            >
              {t("common.retry")}
            </Button>
          }
        />
      </ListGroup>
    );
  }
  const connection = data.value;
  const enabled = connection.enabledCapabilities;
  const pending =
    connect.isPending ||
    updateCapabilities.isPending ||
    disable.isPending ||
    disconnect.isPending;
  return (
    <ListGroup aria-labelledby="microsoft365-heading">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="microsoft365-heading">
            {t("settings.connections.microsoft365Title")}
          </ListGroupTitle>
        </ListGroupHeading>
        <ListGroupDescription>
          {t("settings.connections.microsoft365Description")}
        </ListGroupDescription>
      </ListGroupHeader>
      <List>
        {MICROSOFT365_CAPABILITIES.map((capability) => {
          const allowed = enabled.includes(capability);
          const connected =
            connection.connection?.status === "connected" &&
            connection.connection.capabilities.includes(capability);
          const reconnect =
            allowed && connection.connection?.status === "reconnect_required";
          let status = t("settings.connections.notConnected");
          if (reconnect) {
            status = t("knowledge.mcp.needsReauth");
          } else if (connected && allowed) {
            status = t("settings.connections.connected");
          }
          return (
            <ListItem key={capability}>
              <ListItemContent>
                <ListItemTitle>
                  {capability === "calendar.read"
                    ? t("appearance.calendar")
                    : t("common.files")}
                </ListItemTitle>
              </ListItemContent>
              <ListItemStatus
                tone={connected && allowed ? "success" : "neutral"}
              >
                {status}
              </ListItemStatus>
              <ListItemActions>
                {canManage && (
                  <Button
                    disabled={pending}
                    onClick={() =>
                      updateCapabilities.mutate(
                        allowed
                          ? enabled.filter((value) => value !== capability)
                          : [...enabled, capability],
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    {t(
                      allowed
                        ? "knowledge.mcp.disable"
                        : "knowledge.mcp.enable",
                    )}
                  </Button>
                )}
                {allowed && (
                  <Button
                    disabled={pending}
                    onClick={() => connect.mutate(capability)}
                    size="sm"
                    variant="outline"
                  >
                    {t(
                      connected || reconnect
                        ? "knowledge.mcp.reconnect"
                        : "common.connect",
                    )}
                  </Button>
                )}
              </ListItemActions>
            </ListItem>
          );
        })}
      </List>
      <SharepointConnectionActions
        connected={connection.connection !== null}
        enabled={enabled.length > 0 || connection.connection !== null}
        canManage={canManage}
        pending={pending}
        onDisconnect={() => disconnect.mutate()}
        onDisable={() => disable.mutate()}
      />
    </ListGroup>
  );
};
