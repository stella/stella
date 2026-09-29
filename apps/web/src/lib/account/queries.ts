import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { authClient, listAuthSessions } from "@/lib/auth-client";
import { unwrapEden } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";

/** Stands in for the user id in a per-user query key while nobody is signed in. */
export const SIGNED_OUT_QUERY_OWNER = "visitor";

// Avoid a duplicate fetch when Suspense remounts the observer while keeping
// cross-device session changes visible on the next near-immediate focus/mount.
const SESSION_LIST_DEDUPLICATION_WINDOW_MS = 5000;

export const sessionsKeys = {
  all: ["sessions"] as const,
  list: (userId: string) => [...sessionsKeys.all, userId] as const,
};

export const sessionsOptions = (userId: string) =>
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
  });

const LINKED_ACCOUNTS_STALE_TIME_MS = 5 * 60 * 1000;

export const linkedAccountsOptions = (userId: string) =>
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
  });

export const pendingDeletionTasksOptions = (userId: string) =>
  queryOptions({
    queryKey: ["me", "delete", "pending-tasks", userId] as const,
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api.me.delete["pending-tasks"].get({ fetch: { signal } }),
      ),
  });
