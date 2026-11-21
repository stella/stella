import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { authClient, listAuthSessions } from "@/lib/auth-client";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

/** Stands in for the user id in a per-user query key while nobody is signed in. */
export const SIGNED_OUT_QUERY_OWNER = "visitor";

// Avoid a duplicate fetch when Suspense remounts the observer while keeping
// cross-device session changes visible on the next near-immediate focus/mount.
const SESSION_LIST_DEDUPLICATION_WINDOW_MS = 5000;

const sessionsKeys = {
  all: ["sessions"] as const,
  list: (userId: string) => [...sessionsKeys.all, userId] as const,
};

/** The account's live sessions; a write to the account refreshes them. */
export const sessionsOptions = (userId: string) =>
  resourceQueryOptions(
    queryOptions({
      staleTime: SESSION_LIST_DEDUPLICATION_WINDOW_MS,
      queryKey: sessionsKeys.list(userId),
      queryFn: async () => {
        const result = await listAuthSessions();

        if (result.error) {
          throw toAuthClientError(result.error);
        }

        return result.data;
      },
    }),
    { resources: [RESOURCE_TYPE.USER], scope: { type: "user", userId } },
  );

const LINKED_ACCOUNTS_STALE_TIME_MS = 5 * 60 * 1000;

/** The account's linked sign-in methods; a write to the account refreshes them. */
export const linkedAccountsOptions = (userId: string) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: ["auth", "accounts", userId] as const,
      queryFn: async () => {
        const { data, error } = await authClient.listAccounts();
        if (error) {
          throw toAuthClientError(error);
        }
        return data;
      },
      staleTime: LINKED_ACCOUNTS_STALE_TIME_MS,
    }),
    { resources: [RESOURCE_TYPE.USER], scope: { type: "user", userId } },
  );

export const pendingDeletionTasksOptions = (userId: string) =>
  queryOptions({
    queryKey: ["me", "delete", "pending-tasks", userId] as const,
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api.me.delete["pending-tasks"].get({ fetch: { signal } }),
      ),
  });
