import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { SafeId } from "@stll/api-contract/safe-id";

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
} from "@/lib/law-search-history";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type HistoryInput = Parameters<(typeof api)["search-history"]["post"]>[0];
type LawHistoryScope = {
  userId: string | undefined;
  organizationId: string | null | undefined;
};
const lawHistoryKey = ({ userId, organizationId }: LawHistoryScope) => [
  "law-search-history",
  { userId, organizationId },
];

/** The owner-scoped TanStack query shares this import across mounted readers. */
type ImportLocalLawHistoryOptions = {
  userId: string;
  signal: AbortSignal;
  isCurrentScope: () => boolean;
};

const importLocalLawHistory = async ({
  userId,
  signal,
  isCurrentScope,
}: ImportLocalLawHistoryOptions) => {
  const storage = browserStateStorage("local");
  const scopedKey = userStorageKey(LAW_HISTORY_STORAGE_KEY, {
    kind: "user",
    userId,
  });
  await migrateLocalLawHistory({
    storage,
    userKey: scopedKey,
    canRemove: () => !signal.aborted && isCurrentScope(),
    importEntries: async (entries) => {
      unwrapEden(
        await api["search-history"].import.post(
          { entries },
          { fetch: { signal } },
        ),
      );
    },
  });
};

export const useLawHistory = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const sessionView = useQueryView(useQuery(sessionOptions));
  useQueryViewError(sessionView);
  const session = sessionView.type === "items" ? sessionView.items : null;
  const userId = session?.user.id;
  const organizationId = session?.session.activeOrganizationId;
  const queryKey = lawHistoryKey({ userId, organizationId });
  const enabled =
    userId !== undefined &&
    organizationId !== null &&
    organizationId !== undefined;
  const query = useQuery({
    queryKey,
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      if (
        userId === undefined ||
        organizationId === null ||
        organizationId === undefined
      ) {
        return [];
      }
      await importLocalLawHistory({
        userId,
        signal,
        isCurrentScope: () => {
          const current = queryClient.getQueryData(sessionOptions.queryKey);
          return (
            current?.user.id === userId &&
            current.session.activeOrganizationId === organizationId
          );
        },
      });
      const page = unwrapEden(
        await api["search-history"].get({
          query: { limit: LAW_HISTORY_DISPLAY_LIMIT },
          fetch: { signal },
        }),
      );
      return page.items;
    },
  });
  const view = useQueryView(query);
  useQueryViewError(view);
  const onError = (error: unknown) => notifyUserError(error, t("common.error"));
  const onSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };
  const record = useMutation({
    mutationFn: async (entry: HistoryInput) => {
      if (!enabled) {
        return;
      }
      return unwrapEden(await api["search-history"].post(entry));
    },
    onError,
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: async (id: SafeId<"searchHistoryEntry">) =>
      unwrapEden(await api["search-history"]({ entryId: id }).delete()),
    onError,
    onSuccess,
  });
  const clear = useMutation({
    mutationFn: async () => unwrapEden(await api["search-history"].delete()),
    onError,
    onSuccess,
  });
  return {
    enabled,
    entries: enabled && view.type === "items" ? view.items : [],
    isPending: enabled && view.type === "pending",
    error: view.type === "error" ? view.error : null,
    record,
    remove,
    clear,
  };
};
