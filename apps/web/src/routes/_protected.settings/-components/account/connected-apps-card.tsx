import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Frame } from "@stll/ui/components/frame";
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { stellaToast } from "@stll/ui/components/toast";

import { getFormattingLocale } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";
import type { OAuthScopeDisplayEntry } from "@/lib/oauth-scopes";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type { ConnectedApp } from "@/routes/_protected.settings/-queries/connections";
import {
  connectedAppsKeys,
  connectedAppsOptions,
} from "@/routes/_protected.settings/-queries/connections";

export const ConnectedAppsCard = () => {
  const t = useTranslations();
  const { data } = useSuspenseQuery(connectedAppsOptions);
  const connections = data.connections;

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">
          {t("settings.connections.connectedAppsTitle")}
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {t("settings.connections.connectedAppsDescription")}
        </p>
      </div>
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.name")}</TableHead>
              <TableHead>{t("settings.connections.scopesLabel")}</TableHead>
              <TableHead>{t("settings.connections.connectedColumn")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <ConnectedAppRow connection={connection} key={connection.id} />
            ))}
            {connections.length === 0 && (
              <TableRow>
                <TableCell
                  className="text-muted-foreground text-center"
                  colSpan={4}
                >
                  {t("settings.connections.connectedAppsEmpty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Frame>
    </div>
  );
};

const SKELETON_ROW_KEYS = ["a", "b"];

/** Structural placeholder for the route's `pendingComponent`: mirrors the
 * real table so the page does not jump once the query resolves. */
export const ConnectedAppsCardSkeleton = () => (
  <div className="flex flex-col gap-3">
    <div className="space-y-1">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-4 w-96 max-w-full" />
    </div>
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Skeleton className="h-3 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-3 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-3 w-20" />
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {SKELETON_ROW_KEYS.map((key) => (
            <TableRow key={key}>
              <TableCell>
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell className="text-end">
                <Skeleton className="ms-auto h-6 w-20" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  </div>
);

const ConnectedAppRow = ({ connection }: { connection: ConnectedApp }) => {
  const t = useTranslations();
  const scopeEntries = toOAuthScopeDisplayEntries(connection.scopes);
  const displayName = connection.clientName ?? connection.clientId;

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <BidiText as="span" className="text-foreground font-medium">
            {displayName}
          </BidiText>
          {connection.organizationName ? (
            <span className="text-muted-foreground text-xs">
              {t("common.organization")}:{" "}
              <BidiText>{connection.organizationName}</BidiText>
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <ScopeList entries={scopeEntries} />
      </TableCell>
      <TableCell title={formatFullTimestamp(connection.createdAt)}>
        {formatRelativeTime(connection.createdAt)}
      </TableCell>
      <TableCell className="text-end">
        <DisconnectButton clientName={displayName} consentId={connection.id} />
      </TableCell>
    </TableRow>
  );
};

const ScopeList = ({ entries }: { entries: OAuthScopeDisplayEntry[] }) => {
  const t = useTranslations();

  const labels = entries.map((entry) => translateOAuthScopeEntry(t, entry));

  // `Intl.ListFormat` (not a hardcoded ", ") so the separator and
  // conjunction follow the active locale's conventions.
  return (
    <span>
      {new Intl.ListFormat(getFormattingLocale(), {
        style: "short",
        type: "conjunction",
      }).format(labels)}
    </span>
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
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
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>
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
