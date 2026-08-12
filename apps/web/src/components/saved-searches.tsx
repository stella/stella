import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  BookmarkPlusIcon,
  LoaderIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { contentDir } from "@stll/ui/hooks/use-content-dir";
import type { OverlayLayer } from "@stll/ui/lib/overlay-layer";

import {
  canSaveSearch,
  savedSearchKeys,
  shouldShowSavedSearchList,
  toSavedSearchCriteria,
} from "@/components/saved-searches.logic";
import type { SearchFilters } from "@/components/search-filters.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

const SAVED_SEARCHES_PAGE_SIZE = 25;
const SAVED_SEARCH_NAME_MAX_LENGTH = 256;

type SavedSearchPage = NonNullable<
  Awaited<ReturnType<(typeof api)["saved-searches"]["get"]>>["data"]
>;
type SavedSearch = SavedSearchPage["items"][number];

type SavedSearchDialog =
  | { type: "closed" }
  | { type: "create"; name: string }
  | { type: "rename"; name: string; search: SavedSearch }
  | { type: "delete"; search: SavedSearch };

type SavedSearchesProps = {
  filters: SearchFilters;
  isOpen: boolean;
  query: string;
  onApply: (criteria: SavedSearch["criteria"]) => void;
  overlayLayer?: OverlayLayer;
  showList?: boolean;
  showTrigger?: boolean;
};

export const SavedSearches = ({
  filters,
  isOpen,
  query,
  onApply,
  overlayLayer = "default",
  showList = true,
  showTrigger = true,
}: SavedSearchesProps) => {
  const analytics = useAnalytics();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const t = useTranslations();
  const [dialog, setDialog] = useState<SavedSearchDialog>({ type: "closed" });

  const savedSearchQueryKey = savedSearchKeys.list({
    organizationId: activeOrganizationId,
    userId,
  });
  const hasActiveCriteria = canSaveSearch({ filters, query });

  const savedSearchesQuery = useInfiniteQuery({
    queryKey: savedSearchQueryKey,
    queryFn: async ({ pageParam, signal }) => {
      const response = await api["saved-searches"].get({
        query: {
          limit: SAVED_SEARCHES_PAGE_SIZE,
          ...(pageParam !== undefined && { cursor: pageParam }),
        },
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: isOpen,
  });

  const invalidateSavedSearches = async () =>
    await queryClient.invalidateQueries({ queryKey: savedSearchQueryKey });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const criteria = toSavedSearchCriteria({ filters, query });
      const { time, workspaceIds, ...requiredCriteria } = criteria;
      return unwrapEden(
        await api["saved-searches"].post({
          name,
          criteria: {
            ...requiredCriteria,
            workspaceIds: workspaceIds.map((workspaceId) =>
              toSafeId<"workspace">(workspaceId),
            ),
            ...(time !== undefined && { time }),
          },
        }),
      );
    },
    onSuccess: async () => {
      setDialog({ type: "closed" });
      await invalidateSavedSearches();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({
      name,
      savedSearchId,
    }: {
      name: string;
      savedSearchId: SavedSearch["id"];
    }) =>
      unwrapEden(
        await api["saved-searches"]({ savedSearchId }).patch({ name }),
      ),
    onSuccess: async () => {
      setDialog({ type: "closed" });
      await invalidateSavedSearches();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (savedSearchId: SavedSearch["id"]) =>
      unwrapEden(await api["saved-searches"]({ savedSearchId }).delete()),
    onSuccess: async () => {
      setDialog({ type: "closed" });
      await invalidateSavedSearches();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
  });

  const savedSearches = savedSearchesQuery.data?.pages.flatMap(
    (page) => page.items,
  );
  const hasSavedSearches = (savedSearches?.length ?? 0) > 0;
  const shouldShowList =
    showList &&
    shouldShowSavedSearchList({
      itemCount: hasSavedSearches ? (savedSearches?.length ?? 0) : 0,
      status: savedSearchesQuery.status,
    });
  const savedSearchesError = savedSearchesQuery.error;
  useExternalSyncEffect(() => {
    if (!showList || !savedSearchesError) {
      return;
    }
    analytics.captureError(savedSearchesError);
  }, [analytics, savedSearchesError, showList]);
  const isSaving = createMutation.isPending || renameMutation.isPending;
  const isMutatingSavedSearch = isSaving || deleteMutation.isPending;
  const dialogName =
    dialog.type === "create" || dialog.type === "rename" ? dialog.name : "";

  const updateDialogName = (name: string) => {
    setDialog((current) => {
      if (current.type === "create") {
        return { type: "create", name };
      }
      if (current.type === "rename") {
        return { type: "rename", name, search: current.search };
      }
      return current;
    });
  };

  const saveName = () => {
    const name = dialogName.trim();
    if (!name) {
      return;
    }
    if (dialog.type === "create") {
      createMutation.mutate(name);
      return;
    }
    if (dialog.type === "rename") {
      renameMutation.mutate({ name, savedSearchId: dialog.search.id });
    }
  };

  return (
    <>
      {showTrigger && (
        <Button
          aria-label={t("search.saveSearch")}
          className="size-11 shrink-0"
          disabled={!hasActiveCriteria || isMutatingSavedSearch}
          onClick={() => setDialog({ type: "create", name: "" })}
          size="icon"
          title={t("search.saveSearch")}
          variant="ghost"
        >
          <BookmarkPlusIcon className="size-4" />
        </Button>
      )}

      {shouldShowList && (
        <section className="space-y-1">
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {t("search.savedSearches")}
          </h3>
          {savedSearchesQuery.isPending && (
            <div className="flex h-11 items-center px-2">
              <LoaderIcon className="text-muted-foreground size-4 animate-spin" />
            </div>
          )}
          {savedSearchesQuery.isError && (
            <Button
              className="h-11 w-full justify-start"
              onClick={() => {
                detached(
                  savedSearchesQuery.refetch(),
                  "saved-searches.refetch",
                );
              }}
              variant="ghost"
            >
              {t("common.retry")}
            </Button>
          )}
          {savedSearches?.map((savedSearch) => (
            <div className="flex min-w-0 items-center" key={savedSearch.id}>
              <Button
                className="h-11 min-w-0 flex-1 justify-start text-start text-sm"
                onClick={() => onApply(savedSearch.criteria)}
                variant="ghost"
              >
                <BidiText as="span" className="truncate">
                  {savedSearch.name}
                </BidiText>
              </Button>
              <Button
                aria-label={t("common.rename")}
                className="size-11 shrink-0"
                disabled={isMutatingSavedSearch}
                onClick={() =>
                  setDialog({
                    type: "rename",
                    name: savedSearch.name,
                    search: savedSearch,
                  })
                }
                size="icon"
                title={t("common.rename")}
                variant="ghost"
              >
                <PencilIcon className="size-4" />
              </Button>
              <Button
                aria-label={t("common.delete")}
                className="size-11 shrink-0"
                disabled={isMutatingSavedSearch}
                onClick={() =>
                  setDialog({ type: "delete", search: savedSearch })
                }
                size="icon"
                title={t("common.delete")}
                variant="ghost"
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          ))}
          {savedSearchesQuery.hasNextPage && (
            <Button
              className="h-11 w-full"
              disabled={savedSearchesQuery.isFetchingNextPage}
              onClick={() => {
                detached(
                  savedSearchesQuery.fetchNextPage(),
                  "saved-searches.fetch-next-page",
                );
              }}
              variant="ghost"
            >
              {savedSearchesQuery.isFetchingNextPage ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                t("common.loadMore")
              )}
            </Button>
          )}
        </section>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setDialog({ type: "closed" });
          }
        }}
        open={dialog.type === "create" || dialog.type === "rename"}
      >
        <DialogPopup layer={overlayLayer}>
          <DialogHeader>
            <DialogTitle>
              {dialog.type === "rename"
                ? t("search.renameSearchTitle")
                : t("search.saveSearchTitle")}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
          >
            <div className="px-6 pb-6">
              <label className="sr-only" htmlFor="saved-search-name">
                {t("common.name")}
              </label>
              <Input
                autoFocus
                dir={contentDir(dialogName)}
                disabled={isSaving}
                id="saved-search-name"
                maxLength={SAVED_SEARCH_NAME_MAX_LENGTH}
                onChange={(event) => updateDialogName(event.target.value)}
                placeholder={t("search.saveSearchNamePlaceholder")}
                value={dialogName}
              />
            </div>
            <DialogFooter>
              <Button
                className="min-h-11"
                disabled={isSaving}
                onClick={() => setDialog({ type: "closed" })}
                type="button"
                variant="ghost"
              >
                {t("common.cancel")}
              </Button>
              <Button
                className="min-h-11"
                disabled={!dialogName.trim() || isSaving}
                type="submit"
              >
                {isSaving && <LoaderIcon className="size-4 animate-spin" />}
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDialog({ type: "closed" });
          }
        }}
        open={dialog.type === "delete"}
      >
        <AlertDialogPopup layer={overlayLayer}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("search.deleteSearchTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.type === "delete" &&
                t.rich("search.deleteSearchDescription", {
                  bdi: (chunks) => <BidiText>{chunks}</BidiText>,
                  name: dialog.search.name,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={deleteMutation.isPending}
              render={
                <Button
                  className="min-h-11"
                  disabled={deleteMutation.isPending}
                  variant="ghost"
                />
              }
            >
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              className="min-h-11"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (dialog.type === "delete") {
                  deleteMutation.mutate(dialog.search.id);
                }
              }}
              variant="destructive"
            >
              {deleteMutation.isPending && (
                <LoaderIcon className="size-4 animate-spin" />
              )}
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
