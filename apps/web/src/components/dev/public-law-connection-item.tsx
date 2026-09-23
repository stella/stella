import type { ReactNode } from "react";

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { CableIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import { Loader } from "@stll/ui/loader";
import { MenuItem } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

const CONNECTING_POLL_INTERVAL_MS = 1000;

/**
 * The dev guard answers outside dev with a 404, which Eden reports as an
 * error; a successful raw `Response` is not a state the route produces.
 */
const unexpectedResponse = () =>
  panic("The dev public-law connection route returned a raw Response");

const readPublicLawConnection = async (signal: AbortSignal) => {
  const data = unwrapEden(
    await api.dev["public-law-connection"].get({ fetch: { signal } }),
  );
  return data instanceof Response ? unexpectedResponse() : data;
};

type PublicLawConnection = Awaited<ReturnType<typeof readPublicLawConnection>>;

const publicLawConnectionOptions = queryOptions({
  queryKey: ["dev", "public-law-connection"],
  queryFn: async ({ signal }) => await readPublicLawConnection(signal),
  refetchInterval: (query) =>
    query.state.data?.status === "connecting"
      ? CONNECTING_POLL_INTERVAL_MS
      : false,
});

type ItemView = {
  icon: ReactNode;
  label: string;
  detail: string | undefined;
  tone: "muted" | "destructive";
  canConnect: boolean;
};

const viewForConnection = (connection: PublicLawConnection): ItemView => {
  switch (connection.status) {
    case "unconfigured":
      return {
        icon: <CableIcon />,
        label: "Connect case law",
        detail: `Set ${connection.missing} in apps/api/.env`,
        tone: "muted",
        canConnect: false,
      };
    case "disconnected":
      return {
        icon: <CableIcon />,
        label: "Connect case law",
        detail: connection.reason,
        tone: "muted",
        canConnect: true,
      };
    case "connecting":
      return {
        icon: <Loader label="Connecting case law" size="sm" />,
        label: "Connecting case law…",
        detail: undefined,
        tone: "muted",
        canConnect: false,
      };
    case "connected":
      return {
        icon: <CircleCheckIcon />,
        label: "Case law connected",
        detail: "Click to reconnect",
        tone: "muted",
        canConnect: true,
      };
    case "failed":
      return {
        icon: <TriangleAlertIcon />,
        label: "Case law connection failed",
        detail: connection.message,
        tone: "destructive",
        canConnect: true,
      };
    default:
      connection satisfies never;
      return panic(`Unhandled connection status: ${String(connection)}`);
  }
};

/**
 * Dev menu action that runs the API's configured connect command, so the
 * local stack reads the case-law and statute corpus its env points at.
 */
export const PublicLawConnectionItem = () => {
  const queryClient = useQueryClient();
  const connection = useQuery(publicLawConnectionOptions);
  const connect = useMutation({
    mutationFn: async () => {
      const data = unwrapEden(await api.dev["public-law-connection"].post());
      return data instanceof Response ? unexpectedResponse() : data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(publicLawConnectionOptions.queryKey, data);
    },
  });

  const view: ItemView =
    connection.data === undefined
      ? {
          icon: <CableIcon />,
          label: "Connect case law",
          detail: connection.isError
            ? connection.error.message
            : "Checking connection…",
          tone: connection.isError ? "destructive" : "muted",
          canConnect: false,
        }
      : viewForConnection(connection.data);
  const detail = connect.isError ? connect.error.message : view.detail;

  return (
    <MenuItem
      closeOnClick={false}
      disabled={!view.canConnect || connect.isPending}
      onClick={() => {
        connect.mutate();
      }}
    >
      {view.icon}
      <span className="flex min-w-0 flex-col">
        <span>{view.label}</span>
        {detail !== undefined && (
          <span
            className={cn(
              "line-clamp-3 max-w-64 text-xs wrap-break-word",
              view.tone === "destructive" || connect.isError
                ? "text-destructive-foreground"
                : "text-muted-foreground",
            )}
            title={detail}
          >
            {detail}
          </span>
        )}
      </span>
    </MenuItem>
  );
};
