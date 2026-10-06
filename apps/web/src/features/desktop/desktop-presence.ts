import { queryOptions, useQuery } from "@tanstack/react-query";
import { panic, Result, UnhandledException } from "better-result";

import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { useQueryView } from "@/lib/use-query-view";

export type DesktopPresenceType = DesktopPresence["type"];

type DesktopPresenceKey = {
  userId: string;
  organizationId: string;
};

const desktopPresenceKeys = {
  all: ({ userId, organizationId }: DesktopPresenceKey) =>
    ["desktop-presence", organizationId, userId] as const,
};

const DESKTOP_PRESENCE_STALE_TIME_MS = 30_000;

export const desktopPresenceOptions = (key: DesktopPresenceKey) =>
  queryOptions({
    queryKey: desktopPresenceKeys.all(key),
    queryFn: async ({ signal }) => {
      const result = await Result.tryPromise({
        try: async () =>
          unwrapEden(await api.desktop.presence.get({ fetch: { signal } })),
        catch: (cause) =>
          cause instanceof Error ? cause : new UnhandledException({ cause }),
      });
      if (Result.isError(result) && !signal.aborted) {
        getAnalytics().captureError(result.error);
      }
      return readQueryResult(result);
    },
    staleTime: DESKTOP_PRESENCE_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    retry: false,
  });

const ASSUMED_PRESENCE = {
  type: "current",
} as const satisfies Pick<DesktopPresence, "type">;

/** A missing or failed observation must not block a working desktop deep link. */
export const useDesktopPresence = (): Pick<DesktopPresence, "type"> => {
  const user = useMaybeAuthenticatedUser();
  const query = useQuery({
    ...desktopPresenceOptions({
      userId: user?.id ?? SIGNED_OUT_QUERY_OWNER,
      organizationId: user?.activeOrganizationId ?? SIGNED_OUT_QUERY_OWNER,
    }),
    enabled: user !== null,
  });
  const view = useQueryView(query);
  switch (view.type) {
    case "items":
      return view.refetchError === undefined ? view.items : ASSUMED_PRESENCE;
    case "pending":
    case "error":
    case "empty":
      return ASSUMED_PRESENCE;
    default:
      view satisfies never;
      return panic("Unhandled desktop presence query state");
  }
};
