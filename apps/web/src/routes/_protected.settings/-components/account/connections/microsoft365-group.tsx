import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  MICROSOFT365_CAPABILITIES,
  type Microsoft365Capability,
} from "@stll/api-contract/microsoft365";
import { Button } from "@stll/ui/button";
import {
  List,
  ListGroup,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemContent,
  ListItemTitle,
  ListItemActions,
  ListItemStatus,
  ListGroupDescription,
} from "@stll/ui/list";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";
import { microsoft365Options } from "@/routes/_protected.settings/-queries/connections";

export const Microsoft365Group = () => {
  const t = useTranslations();
  const { id, activeOrganizationId } = useAuthenticatedUser();
  const options = microsoft365Options({
    organizationId: activeOrganizationId,
    userId: id,
  });
  const { data, error } = useQuery(options);
  const canManage = usePermissions({ organizationSettings: ["update"] });
  const connect = useSettingsMutation({
    invalidate: options.queryKey,
    mutationFn: async (capability: Microsoft365Capability) =>
      unwrapEden(
        await api.microsoft365.connect.post({ capabilities: [capability] }),
      ),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    errorToast: { title: t("common.error") },
  });
  const policy = useSettingsMutation({
    invalidate: options.queryKey,
    mutationFn: async (input: {
      enabled: boolean;
      capabilities: Microsoft365Capability[];
    }) => unwrapEden(await api.microsoft365.enablement.put(input)),
    errorToast: { title: t("common.error") },
  });
  const disconnect = useSettingsMutation({
    invalidate: options.queryKey,
    mutationFn: async () =>
      unwrapEden(await api.microsoft365.connection.delete()),
    errorToast: { title: t("common.error") },
  });
  // Deployment-disabled connections return 404 and have no settings surface.
  if (error && !(APIError.is(error) && error.status === 404)) {
    return <p role="alert">{t("settings.connections.microsoft365Error")}</p>;
  }
  if (!data) {
    return null;
  }
  const enabledCapabilities: Microsoft365Capability[] = [];
  if (data.policy.microsoft365FilesReadEnabled) {
    enabledCapabilities.push("files.read");
  }
  if (data.policy.microsoft365CalendarReadEnabled) {
    enabledCapabilities.push("calendar.read");
  }
  const pending = connect.isPending || policy.isPending || disconnect.isPending;
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
          const allowed =
            data.policy.microsoft365ConnectionEnabled &&
            enabledCapabilities.includes(capability);
          const connected =
            data.connection?.status === "connected" &&
            data.connection.capabilities.includes(capability);
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
                {t(
                  connected && allowed
                    ? "settings.connections.connected"
                    : "settings.connections.notConnected",
                )}
              </ListItemStatus>
              <ListItemActions>
                {canManage && (
                  <Button
                    disabled={pending}
                    onClick={() =>
                      policy.mutate({
                        enabled: true,
                        capabilities: allowed
                          ? enabledCapabilities.filter(
                              (value) => value !== capability,
                            )
                          : [...new Set([...enabledCapabilities, capability])],
                      })
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
                      connected ? "knowledge.mcp.reconnect" : "common.connect",
                    )}
                  </Button>
                )}
              </ListItemActions>
            </ListItem>
          );
        })}
      </List>
      {data.connection && (
        <Button
          disabled={pending}
          onClick={() => disconnect.mutate()}
          variant="outline"
        >
          {t("common.disconnect")}
        </Button>
      )}
      {canManage && data.policy.microsoft365ConnectionEnabled && (
        <Button
          disabled={pending}
          onClick={() => policy.mutate({ enabled: false, capabilities: [] })}
          variant="ghost"
        >
          {t("settings.connections.microsoft365Disable")}
        </Button>
      )}
    </ListGroup>
  );
};
