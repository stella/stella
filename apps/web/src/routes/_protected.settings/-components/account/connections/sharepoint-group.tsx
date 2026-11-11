import { useState } from "react";

import { panic } from "better-result";
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
import { LibraryIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";

import {
  SHAREPOINT_ACCESS,
  SHAREPOINT_CONNECTION_STATE,
  type SharepointAccess,
  sharepointConnectionState,
} from "@/features/sharepoint/sharepoint-access.logic";
import {
  useSharepointAccess,
  useSharepointConnect,
  useSharepointDisconnect,
} from "@/features/sharepoint/sharepoint-hooks";
import type { SharepointConnection } from "@/features/sharepoint/sharepoint-queries";
import { matchesConnectionQuery } from "@/lib/account/connections.logic";
import { formatRelativeTime } from "@/lib/relative-time";

type ShownSharepointAccess = Exclude<
  SharepointAccess,
  { type: typeof SHAREPOINT_ACCESS.unavailable }
>;

export type SharepointConnectionRow =
  { visible: false } | { visible: true; access: ShownSharepointAccess };

/**
 * The member's SharePoint row, when the deployment offers SharePoint and the
 * row matches the search. Until the gate is known nothing is shown.
 */
export const useSharepointConnectionRow = (
  query: string,
): SharepointConnectionRow => {
  const t = useTranslations();
  const access = useSharepointAccess();
  if (access === null || access.type === SHAREPOINT_ACCESS.unavailable) {
    return { visible: false };
  }
  const accountLabel =
    access.type === SHAREPOINT_ACCESS.enabled
      ? (access.connection?.accountLabel ?? "")
      : "";
  return matchesConnectionQuery(query, [
    t("sharepoint.title"),
    t("sharepoint.description"),
    accountLabel,
  ])
    ? { visible: true, access }
    : { visible: false };
};

/** The member's own Microsoft connection for SharePoint and OneDrive. */
export const SharepointGroup = ({
  access,
}: {
  access: ShownSharepointAccess;
}) => {
  const t = useTranslations();
  return (
    <ListGroup aria-label={t("sharepoint.title")}>
      <List>
        <ListItem>
          <ListItemMedia>
            <LibraryIcon />
          </ListItemMedia>
          {access.type === SHAREPOINT_ACCESS.disabled ? (
            <>
              <ListItemContent>
                <ListItemTitle>{t("sharepoint.title")}</ListItemTitle>
                <ListItemDescription>
                  {t("sharepoint.askAdmin")}
                </ListItemDescription>
              </ListItemContent>
              <ListItemActions>
                <ListItemStatus>
                  {t("settings.connections.turnedOff")}
                </ListItemStatus>
              </ListItemActions>
            </>
          ) : (
            <SharepointConnectionContent connection={access.connection} />
          )}
        </ListItem>
      </List>
    </ListGroup>
  );
};

const SharepointConnectionContent = ({
  connection,
}: {
  connection: SharepointConnection | null;
}) => {
  const t = useTranslations();
  const connect = useSharepointConnect();
  const state = sharepointConnectionState(connection);
  const connectButton = (label: string) => (
    <Button
      loading={connect.isPending}
      onClick={() => connect.mutate()}
      size="xs"
      variant="outline"
    >
      {label}
    </Button>
  );

  switch (state) {
    case SHAREPOINT_CONNECTION_STATE.notConnected:
      return (
        <>
          <ListItemContent>
            <ListItemTitle>{t("sharepoint.title")}</ListItemTitle>
            <ListItemDescription>
              {t("sharepoint.description")}
            </ListItemDescription>
          </ListItemContent>
          <ListItemActions>
            {connectButton(t("common.connect"))}
          </ListItemActions>
        </>
      );
    case SHAREPOINT_CONNECTION_STATE.connected:
    case SHAREPOINT_CONNECTION_STATE.reconnectRequired: {
      const reconnect = state === SHAREPOINT_CONNECTION_STATE.reconnectRequired;
      return (
        <>
          <ListItemContent>
            <ListItemTitle>{t("sharepoint.title")}</ListItemTitle>
            <ListItemDescription>
              {connection !== null && (
                <ConnectionDescription connection={connection} />
              )}
            </ListItemDescription>
          </ListItemContent>
          <ListItemActions>
            <ListItemStatus tone={reconnect ? "warning" : "success"}>
              {reconnect
                ? t("sharepoint.reconnectRequired")
                : t("common.connected")}
            </ListItemStatus>
            {reconnect && connectButton(t("common.reconnect"))}
            <DisconnectButton />
          </ListItemActions>
        </>
      );
    }
    default:
      state satisfies never;
      return panic("Unknown SharePoint connection state");
  }
};

/** The Microsoft account, or when it was connected if Microsoft named none. */
const ConnectionDescription = ({
  connection,
}: {
  connection: SharepointConnection;
}) => {
  const t = useTranslations();
  if (connection.accountLabel) {
    return <BidiText>{connection.accountLabel}</BidiText>;
  }
  return t("settings.connections.connectedAgo", {
    time: formatRelativeTime(connection.createdAt),
  });
};

const DisconnectButton = () => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const disconnect = useSharepointDisconnect();
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>
        {t("common.disconnect")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("sharepoint.disconnectTitle")}</DialogTitle>
          <DialogDescription>
            {t("sharepoint.disconnectDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            loading={disconnect.isPending}
            onClick={() => {
              disconnect.mutate(undefined, {
                onSuccess: () => setOpen(false),
              });
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
