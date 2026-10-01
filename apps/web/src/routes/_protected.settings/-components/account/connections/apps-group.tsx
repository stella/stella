import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { CheckIcon } from "@stll/ui/icons";
import {
  List,
  ListEmpty,
  ListGroup,
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
  ListItemTitle,
} from "@stll/ui/list";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { stellaToast } from "@stll/ui/toast";

import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import {
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type { ConnectedApp } from "@/routes/_protected.settings/-queries/connections";
import {
  connectedAppsKeys,
  connectedAppsOptions,
} from "@/routes/_protected.settings/-queries/connections";

import { matchesConnectionQuery } from "./connections.logic";

/** Apps the user let into their account (OAuth consents: Claude, Cursor, the
 * CLI). Access is summarised as a count; the full list opens on demand, so a
 * long scope list can never widen the row. */
export type ConnectedAppsData = {
  all: readonly ConnectedApp[];
  visible: readonly ConnectedApp[];
};

export const useConnectedApps = (query: string): ConnectedAppsData => {
  const { id: userId } = useAuthenticatedUser();
  const { data } = useSuspenseQuery(connectedAppsOptions(userId));
  const visible = data.connections.filter((connection) =>
    matchesConnectionQuery(query, [
      connection.clientName ?? connection.clientId,
      connection.organizationName,
    ]),
  );
  return { all: data.connections, visible };
};

export const AppsGroup = ({
  apps: { all, visible },
}: {
  apps: ConnectedAppsData;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <ListGroup aria-labelledby="connections-apps">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="connections-apps">
            {t("settings.connections.connectedAppsTitle")}
            {all.length > 0 && (
              <ListGroupCount>{format.number(visible.length)}</ListGroupCount>
            )}
          </ListGroupTitle>
          <ListGroupDescription>
            {t("settings.connections.connectedAppsDescription")}
          </ListGroupDescription>
        </ListGroupHeading>
      </ListGroupHeader>
      <List>
        {visible.map((connection) => (
          <ConnectedAppRow connection={connection} key={connection.id} />
        ))}
        {all.length === 0 && (
          <ListEmpty>{t("settings.connections.connectedAppsEmpty")}</ListEmpty>
        )}
      </List>
    </ListGroup>
  );
};

const ConnectedAppRow = ({ connection }: { connection: ConnectedApp }) => {
  const t = useTranslations();
  const displayName = connection.clientName ?? connection.clientId;

  return (
    <ListItem>
      <ListItemMedia variant="initial">
        {Array.from(displayName.trim()).at(0)?.toLocaleUpperCase() ?? "?"}
      </ListItemMedia>
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{displayName}</BidiText>
        </ListItemTitle>
        <ListItemDescription>
          {connection.organizationName ? (
            <>
              <BidiText>{connection.organizationName}</BidiText>
              <span aria-hidden="true" className="px-1.5">
                ·
              </span>
            </>
          ) : null}
          <Tooltip
            content={formatFullTimestamp(connection.createdAt)}
            render={<span />}
          >
            {t("settings.connections.connectedAgo", {
              time: formatRelativeTime(connection.createdAt),
            })}
          </Tooltip>
        </ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <AccessPopover clientName={displayName} scopes={connection.scopes} />
        <DisconnectButton clientName={displayName} consentId={connection.id} />
      </ListItemActions>
    </ListItem>
  );
};

const AccessPopover = ({
  clientName,
  scopes,
}: {
  clientName: string;
  scopes: readonly string[];
}) => {
  const t = useTranslations();
  const labels = toOAuthScopeDisplayEntries(scopes).map((entry) =>
    translateOAuthScopeEntry(t, entry),
  );

  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="muted" />}>
        <span className="tabular-nums">
          {t("settings.connections.permissionCount", { count: labels.length })}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-72" side="bottom">
        <div className="flex flex-col gap-2 p-3">
          <p className="text-foreground text-xs font-medium">
            {t("settings.connections.accessTitle", { clientName })}
          </p>
          <ul className="flex flex-col gap-1.5">
            {labels.map((label) => (
              <li
                className="text-muted-foreground flex items-start gap-2 text-xs"
                key={label}
              >
                <CheckIcon className="text-foreground-muted mt-px size-3.5 shrink-0" />
                <span className="text-pretty">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type DisconnectButtonProps = {
  clientName: string;
  consentId: string;
};

const DisconnectButton = ({ clientName, consentId }: DisconnectButtonProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const disconnect = useMutation({
    mutationFn: async () => {
      const response = await api.me["oauth-connections"]({
        consentId,
      }).delete();

      return unwrapEden(response);
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("settings.connections.disconnectSuccess", { clientName }),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: connectedAppsKeys.all,
      });
      setIsOpen(false);
    },
    // On error the dialog stays open so the user keeps the per-app
    // context and can retry.
    onError: (error) => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      analytics.captureError(error);
    },
  });

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        {t("common.disconnect")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {t("settings.connections.disconnectConfirmTitle", { clientName })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.connections.disconnectConfirmDescription", {
              clientName,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            loading={disconnect.isPending}
            onClick={() => {
              disconnect.mutate();
            }}
            variant="destructive"
          >
            {t("common.disconnect")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
