import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

type SsoConnectionKey = {
  organizationId: string;
};

export const ssoConnectionKeys = {
  all: ["settings", "organization", "sso"] as const,
  byOrganization: ({ organizationId }: SsoConnectionKey) => [
    ...ssoConnectionKeys.all,
    organizationId,
  ],
};

export type SsoConnectionResponse = NonNullable<
  Awaited<ReturnType<(typeof api)["sso-connections"]["get"]>>["data"]
>;

export type SsoConnection = Exclude<SsoConnectionResponse["connection"], null>;

const fetchSsoConnection = async ({ signal }: { signal: AbortSignal }) =>
  unwrapEden(
    await api["sso-connections"].get({
      fetch: { signal },
    }),
  );

export const ssoConnectionOptions = ({ organizationId }: SsoConnectionKey) =>
  queryOptions({
    queryKey: ssoConnectionKeys.byOrganization({ organizationId }),
    queryFn: fetchSsoConnection,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
