import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { SafeId } from "@stll/api-contract/safe-id";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { api } from "@/lib/api";
import { sessionOptions } from "@/lib/auth-query-options";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  LAW_HISTORY_DISPLAY_LIMIT,
  LAW_HISTORY_STORAGE_KEY,
  migrateLocalLawHistory,
  type LawRecentFilter,
} from "@/lib/law-search-history";
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
const lawHistoryKeys = {
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

export const useLawHistory = (filter: LawRecentFilter = "all") => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const sessionView = useQueryView(useQuery(sessionOptions));
  useQueryViewError(sessionView);
  const session = sessionView.type === "items" ? sessionView.items : null;
  const userId = session?.user.id;
  const organizationId = session?.session.activeOrganizationId;
  const scope =
    userId === undefined ||
    organizationId === null ||
    organizationId === undefined
      ? null
      : ({ userId, organizationId } as const);
  const enabled = scope !== null;
  const keyScope = { userId, organizationId };
  const importQuery = useQuery({
    queryKey: lawHistoryKeys.import(scope ?? keyScope),
    enabled,
    retry: false,
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
      return null;
    },
  });
  const importView = useQueryView(importQuery);
  useQueryViewError(importView);
  const query = useQuery({
    queryKey: lawHistoryKeys.list({ scope: keyScope, filter }),
    enabled: enabled && importView.type === "items",
    retry: false,
    queryFn: async ({ signal }) => {
      const page = unwrapEden(
        await api["search-history"].get({
          query:
            filter === "all"
              ? { limit: LAW_HISTORY_DISPLAY_LIMIT }
              : { limit: LAW_HISTORY_DISPLAY_LIMIT, kind: filter },
          fetch: { signal },
        }),
      );
      return page.items;
    },
  });
  const view = useQueryView(query);
  useQueryViewError(view);
  const onError = (error: unknown) => notifyUserError(error, t("common.error"));
  type RecordHistoryUse = { scope: LawHistoryOwner; entry: HistoryInput };
  const recordMutation = useMutation({
    mutationFn: async ({ scope: originatingScope, entry }: RecordHistoryUse) =>
      unwrapEden(
        await api["search-history"].post(
          entry,
          historyMutationRequest(originatingScope),
        ),
      ),
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
    recordMutation.mutate({
      scope: { userId: scope.userId, organizationId: scope.organizationId },
      entry,
    });
  });
  type RemoveHistoryUse = {
    scope: LawHistoryOwner;
    id: SafeId<"searchHistoryEntry">;
  };
  const removeMutation = useMutation({
    mutationFn: async ({ scope: originatingScope, id }: RemoveHistoryUse) =>
      unwrapEden(
        await api["search-history"]({ entryId: id }).delete(
          undefined,
          historyMutationRequest(originatingScope),
        ),
      ),
    onError,
    onSuccess: async (_, { scope: originatingScope }) => {
      await queryClient.invalidateQueries({
        queryKey: lawHistoryKeys.lists(originatingScope),
      });
    },
  });
  const removeEntry = useLatestCallback((id: SafeId<"searchHistoryEntry">) => {
    if (scope === null) {
      return;
    }
    removeMutation.mutate({
      scope: { userId: scope.userId, organizationId: scope.organizationId },
      id,
    });
  });
  const clear = useMutation({
    mutationFn: async (capturedScope: LawHistoryOwner) =>
      unwrapEden(
        await api["search-history"].delete(
          undefined,
          historyMutationRequest(capturedScope),
        ),
      ),
    onError,
    onSuccess: async (_, capturedScope) => {
      await queryClient.invalidateQueries({
        queryKey: lawHistoryKeys.lists(capturedScope),
      });
    },
  });
  const importError = importView.type === "error" ? importView.error : null;
  const listError = view.type === "error" ? view.error : null;
  return {
    enabled,
    scope,
    entries: enabled && view.type === "items" ? view.items : [],
    isPending:
      enabled && (importView.type === "pending" || view.type === "pending"),
    error: importError ?? listError,
    record: { mutate: recordEntry },
    remove: { mutate: removeEntry, isPending: removeMutation.isPending },
    clear,
  };
};
