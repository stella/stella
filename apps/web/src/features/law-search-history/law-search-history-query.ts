import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { SafeId } from "@stll/api-contract/safe-id";
import { searchHistoryEntryMatch } from "@stll/api-contract/search-history-identity";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { api } from "@/lib/api";
import { fetchSession } from "@/lib/auth-queries";
import { sessionOptions } from "@/lib/auth-query-options";
import { APIError, shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  LAW_HISTORY_DISPLAY_LIMIT,
  LAW_HISTORY_STORAGE_KEY,
  migrateLocalLawHistory,
  readLawRecent,
  type LawRecentFilter,
} from "@/lib/law-search-history/law-search-history.logic";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type HistoryInput = Parameters<(typeof api)["search-history"]["post"]>[0];
type LawHistoryScope = {
  userId: string | undefined;
  organizationId: string | null | undefined;
};
type LawHistoryOwner = {
  readonly userId: string;
  readonly organizationId: string;
};

/** Every history write names the account and organization that initiated it. */
const historyMutationRequest = (
  scope: LawHistoryOwner,
  signal?: AbortSignal,
) => ({
  query: {
    expectedUserId: scope.userId,
    expectedOrganizationId: scope.organizationId,
  },
  ...(signal === undefined ? {} : { fetch: { signal } }),
});
const historyScopeMatches = ({
  actual,
  expected,
}: {
  actual: LawHistoryOwner;
  expected: LawHistoryOwner;
}) =>
  actual.userId === expected.userId &&
  actual.organizationId === expected.organizationId;

export const lawHistoryKeys = {
  owner: (scope: LawHistoryScope) => ["law-search-history", scope],
  import: (scope: LawHistoryScope) => [
    ...lawHistoryKeys.owner(scope),
    "import",
  ],
  lists: (scope: LawHistoryScope) => [...lawHistoryKeys.owner(scope), "list"],
  list: ({
    scope,
    filter,
  }: {
    scope: LawHistoryScope;
    filter: LawRecentFilter;
  }) => [...lawHistoryKeys.lists(scope), filter],
};

/** The owner-scoped TanStack query shares this import across mounted readers. */
type ImportLocalLawHistoryOptions = {
  scope: LawHistoryOwner;
  signal: AbortSignal;
  isCurrentScope: () => boolean;
};

const importLocalLawHistory = async ({
  scope,
  signal,
  isCurrentScope,
}: ImportLocalLawHistoryOptions) => {
  const storage = browserStateStorage("local");
  const scopedKey = userStorageKey(LAW_HISTORY_STORAGE_KEY, {
    kind: "user",
    userId: scope.userId,
  });
  await migrateLocalLawHistory({
    storage,
    userKey: scopedKey,
    canRemove: () => !signal.aborted && isCurrentScope(),
    importEntries: async (entries) => {
      unwrapEden(
        await api["search-history"].import.post(
          { entries },
          historyMutationRequest(scope, signal),
        ),
      );
    },
  });
};

const resolveLawHistoryOwner = ({ userId, organizationId }: LawHistoryScope) =>
  userId === undefined ||
  organizationId === null ||
  organizationId === undefined
    ? null
    : ({ userId, organizationId } as const);

const localLawHistoryImportOptions = (
  keyScope: LawHistoryScope,
  queryClient: QueryClient,
) => {
  const scope = resolveLawHistoryOwner(keyScope);
  return queryOptions({
    queryKey: lawHistoryKeys.import(scope ?? keyScope),
    enabled: scope !== null,
    retry: shouldRetryAPIRequest,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      if (scope === null) {
        return null;
      }
      await importLocalLawHistory({
        scope: { userId: scope.userId, organizationId: scope.organizationId },
        signal,
        isCurrentScope: () => {
          const current = queryClient.getQueryData(sessionOptions.queryKey);
          return (
            current?.user.id === scope.userId &&
            current.session.activeOrganizationId === scope.organizationId
          );
        },
      });
      await queryClient.invalidateQueries({
        queryKey: lawHistoryKeys.lists(scope),
      });
      return null;
    },
  });
};

type HistoryWrite = { scope: LawHistoryOwner } & (
  | { type: "record"; entry: HistoryInput }
  | {
      type: "remove";
      entry: HistoryInput & { id: SafeId<"searchHistoryEntry"> };
    }
  | { type: "clear" }
);

type CoordinateHistoryWriteOptions = {
  write: HistoryWrite;
  queryClient: QueryClient;
  onError: (error: unknown) => void;
};

/** All interactive writes settle the shared import before changing its captured entries. */
const coordinateHistoryWrite = async ({
  write,
  queryClient,
  onError,
}: CoordinateHistoryWriteOptions) => {
  const storage = browserStateStorage("local");
  const snapshots = [
    userStorageKey(LAW_HISTORY_STORAGE_KEY, {
      kind: "user",
      userId: write.scope.userId,
    }),
    LAW_HISTORY_STORAGE_KEY,
  ].map((key) => ({ key, entries: readLawRecent(storage.getItem(key)) }));
  const localIdentity = (
    entry: (typeof snapshots)[number]["entries"][number],
  ) =>
    `${entry.kind}:${searchHistoryEntryMatch(entry.kind === "search" ? entry : { kind: entry.kind, documentId: entry.id })}`;
  const target =
    write.type === "clear"
      ? null
      : `${write.entry.kind}:${searchHistoryEntryMatch(write.entry)}`;
  const capturedMatches = new Set(
    write.type === "record"
      ? []
      : snapshots.flatMap(({ entries }) =>
          entries
            .map(localIdentity)
            .filter((key) => target === null || key === target),
        ),
  );
  const importKey = localLawHistoryImportOptions(
    write.scope,
    queryClient,
  ).queryKey;
  const pendingImport = queryClient
    .getQueryCache()
    .find({ queryKey: importKey, exact: true })?.promise;
  // Aborting a request does not guarantee that its server write was aborted.
  if (pendingImport !== undefined) {
    const imported = await Result.tryPromise(async () => pendingImport);
    if (Result.isError(imported)) {
      onError(imported.error);
    }
  }
  await sendHistoryWrite(write);
  // A rejected server write must leave the local batch available for import retry.
  for (const { key } of snapshots) {
    const current = readLawRecent(storage.getItem(key));
    const remaining = current.filter(
      (entry) => !capturedMatches.has(localIdentity(entry)),
    );
    if (remaining.length === current.length && write.type !== "clear") {
      continue;
    }
    if (remaining.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(remaining));
    }
  }
  // Retain failed imports with unrelated local entries so their retry remains available.
  if (snapshots.every(({ key }) => storage.getItem(key) === null)) {
    queryClient.setQueryData(importKey, null);
  }
};

const sendHistoryWrite = async (write: HistoryWrite) => {
  const request = historyMutationRequest(write.scope);
  switch (write.type) {
    case "record":
      unwrapEden(await api["search-history"].post(write.entry, request));
      return;
    case "remove":
      unwrapEden(
        await api["search-history"]({ entryId: write.entry.id }).delete(
          {},
          request,
        ),
      );
      return;
    case "clear":
      unwrapEden(await api["search-history"].delete({}, request));
      return;
    default:
      write satisfies never;
      panic("Unhandled law history write");
  }
};

export const useLawHistory = (filter: LawRecentFilter = "all") => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const sessionView = useQueryView(useQuery(sessionOptions));
  useQueryViewError(sessionView);
  const session = sessionView.type === "items" ? sessionView.items : null;
  const userId = session?.user.id;
  const organizationId = session?.session.activeOrganizationId;
  const keyScope = { userId, organizationId };
  const scope = resolveLawHistoryOwner(keyScope);
  const enabled = scope !== null;
  const importQuery = useQuery(
    localLawHistoryImportOptions(keyScope, queryClient),
  );
  const importView = useQueryView(importQuery);
  useQueryViewError(importView);
  const query = useQuery({
    queryKey: lawHistoryKeys.list({ scope: scope ?? keyScope, filter }),
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      if (scope === null) {
        return [];
      }
      const originatingScope = {
        userId: scope.userId,
        organizationId: scope.organizationId,
      };
      const readPage = async () =>
        unwrapEden(
          await api["search-history"].get({
            query:
              filter === "all"
                ? { limit: LAW_HISTORY_DISPLAY_LIMIT }
                : { limit: LAW_HISTORY_DISPLAY_LIMIT, kind: filter },
            fetch: { signal },
          }),
        );
      const page = await readPage();
      if (
        historyScopeMatches({ actual: page.scope, expected: originatingScope })
      ) {
        return page.items;
      }

      // Refresh the authoritative session once; foreign rows never enter this cache.
      const authoritativeSession = await fetchSession({
        bypassCookieCache: true,
      });
      signal.throwIfAborted();
      queryClient.setQueryData(sessionOptions.queryKey, authoritativeSession);
      if (
        authoritativeSession?.user.id !== originatingScope.userId ||
        authoritativeSession.session.activeOrganizationId !==
          originatingScope.organizationId
      ) {
        return readQueryResult(
          Result.err(new APIError({ status: 409, message: t("common.error") })),
        );
      }
      const refreshedPage = await readPage();
      if (
        !historyScopeMatches({
          actual: refreshedPage.scope,
          expected: originatingScope,
        })
      ) {
        return readQueryResult(
          Result.err(new APIError({ status: 409, message: t("common.error") })),
        );
      }
      return refreshedPage.items;
    },
  });
  const view = useQueryView(query);
  useQueryViewError(view);
  const onError = (error: unknown) => notifyUserError(error, t("common.error"));
  const mutation = useMutation({
    mutationFn: (write: HistoryWrite) =>
      coordinateHistoryWrite({ write, queryClient, onError }),
    onError,
    onSuccess: async (_, { scope: originatingScope }) => {
      await queryClient.invalidateQueries({
        queryKey: lawHistoryKeys.lists(originatingScope),
      });
    },
  });
  const recordEntry = useLatestCallback((entry: HistoryInput) => {
    if (scope === null) {
      return;
    }
    mutation.mutate({ type: "record", scope, entry });
  });
  const removeEntry = useLatestCallback(
    (entry: Extract<HistoryWrite, { type: "remove" }>["entry"]) => {
      if (scope === null) {
        return;
      }
      mutation.mutate({ type: "remove", scope, entry });
    },
  );
  const clearEntries = useLatestCallback(
    (capturedScope: LawHistoryOwner, options: { onSuccess: () => void }) => {
      mutation.mutate({ type: "clear", scope: capturedScope }, options);
    },
  );
  const list = (() => {
    switch (view.type) {
      case "items":
        return { status: "ready", entries: view.items } as const;
      case "empty":
        return { status: "ready", entries: [] } as const;
      case "pending":
        return { status: "pending" } as const;
      case "error":
        return { status: "error", error: view.error } as const;
      default:
        view satisfies never;
        return panic("Unhandled law history list state");
    }
  })();
  return {
    enabled,
    scope,
    list: enabled ? list : ({ status: "ready", entries: [] } as const),
    importStatus: importView,
    record: { mutate: recordEntry },
    remove: { mutate: removeEntry, isPending: mutation.isPending },
    clear: { mutate: clearEntries, isPending: mutation.isPending },
  };
};
