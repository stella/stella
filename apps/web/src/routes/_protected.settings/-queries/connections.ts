import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";
import * as v from "valibot";

import { MICROSOFT365_CAPABILITIES } from "@stll/api-contract/microsoft365";

import { api } from "@/lib/api";
import {
  apiResponseResult,
  shouldRetryAPIRequest,
  unwrapApiResponse,
} from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const connectedAppsKeys = {
  all: ["settings", "connections", "connected-apps"] as const,
  list: (userId: string) => [...connectedAppsKeys.all, userId] as const,
};

type ListConnectedAppsFn = (typeof api.me)["oauth-connections"]["get"];

/** The session user's authorized OAuth clients ("connected apps"). */
type ConnectedAppsResponse = NonNullable<
  Awaited<ReturnType<ListConnectedAppsFn>>["data"]
>;

export type ConnectedApp = ConnectedAppsResponse["connections"][number];

const fetchConnectedApps = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<ConnectedAppsResponse> => {
  const response = await api.me["oauth-connections"].get({
    fetch: { signal },
  });
  return unwrapApiResponse(response);
};

// Keyed by the session user; see `sessionsOptions` in
// `apps/web/src/lib/account/queries.ts` for the same shape.
export const connectedAppsOptions = (userId: string) =>
  queryOptions({
    queryKey: connectedAppsKeys.list(userId),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: fetchConnectedApps,
  });

// Older API tasks return exactly { connection }. That shape cannot prove
// calendar policy or stored grants, so it is never interpreted as enabled.
// Remove this branch after those API tasks have drained.
const isLegacySharepointConnectionResponse = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).length === 1 &&
  Object.hasOwn(value, "connection");

const capabilityListSchema = v.array(v.picklist(MICROSOFT365_CAPABILITIES));
const currentSharepointFields = v.object({
  policy: v.object({
    sharepointConnectionEnabled: v.boolean(),
    microsoft365CalendarReadEnabled: v.boolean(),
  }),
  enabledCapabilities: capabilityListSchema,
  connection: v.nullable(v.object({ capabilities: capabilityListSchema })),
});

type SharepointConnectionClassification<T> = Result<
  | { readonly type: "upgrade_required" }
  | { readonly type: "ready"; readonly value: T },
  ClientOperationError
>;

export const classifySharepointConnectionResponse = <T>(
  data: T,
): SharepointConnectionClassification<T> => {
  if (isLegacySharepointConnectionResponse(data)) {
    return Result.ok({ type: "upgrade_required" } as const);
  }
  if (!v.safeParse(currentSharepointFields, data).success) {
    return Result.err(
      new ClientOperationError({
        action: "read-sharepoint-connection",
        message: "Invalid SharePoint connection response",
      }),
    );
  }
  return Result.ok({ type: "ready", value: data } as const);
};

export const sharepointConnectionOptions = ({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) =>
  queryOptions({
    queryKey: [
      "settings",
      "connections",
      "sharepoint",
      organizationId,
      userId,
    ] as const,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }) =>
      readQueryResult(
        apiResponseResult(
          await api.sharepoint.connection.get({ fetch: { signal } }),
        ).andThen(classifySharepointConnectionResponse),
      ),
  });
