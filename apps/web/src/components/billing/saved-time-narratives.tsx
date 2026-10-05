import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFormState,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { BookmarkIcon, BookmarkPlusIcon, Trash2Icon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { stringCursorSeed } from "@/lib/infinite-query";

const PAGE_SIZE = 25;
const NAME_MAX_LENGTH = 128;
export const savedTimeNarrativesKeys = {
  list: (organizationId: string, userId: string) => [
    "saved-time-narratives",
    organizationId,
    userId,
  ],
};

type SavedNarrativePage = NonNullable<
  Awaited<ReturnType<(typeof api)["saved-time-narratives"]["get"]>>["data"]
>;
type SavedNarrative = SavedNarrativePage["items"][number];

type SavedTimeNarrativesProps = {
  narrative: string;
  narrativeLanguage: string | null;
  onSelect: (narrative: string, language: string | null) => void;
};

export const SavedTimeNarratives = ({
  narrative,
  narrativeLanguage,
  onSelect,
}: SavedTimeNarrativesProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedNarrative | null>(null);
  const queryKey = savedTimeNarrativesKeys.list(activeOrganizationId, userId);

  const savedQuery = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api["saved-time-narratives"].get({
          query: {
            limit: PAGE_SIZE,
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: isOpen,
  });

  const reportError = (error: Error) => {
    analytics.captureError(error);
    notifyUserError(error, t("common.somethingWentWrong"));
  };
  const create = useMutation({
    mutationFn: async (savedName: string) =>
      unwrapEden(
        await api["saved-time-narratives"].post({
          name: savedName,
          narrative,
          narrativeLanguage,
        }),
      ),
    onSuccess: async () => {
      setName(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: reportError,
  });
  const remove = useMutation({
    mutationFn: async (id: SavedNarrative["id"]) =>
      unwrapEden(await api["saved-time-narratives"]({ id }).delete()),
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: reportError,
  });

  const items = savedQuery.data
    ? savedQuery.data.pages.flatMap((page) => page.items)
    : [];
  const isolateName = (savedName: string) => `\u2068${savedName}\u2069`;

  return (
    <>
      <Popover onOpenChange={setIsOpen} open={isOpen}>
        <PopoverTrigger
          render={<Button size="sm" type="button" variant="ghost" />}
        >
          <BookmarkIcon className="size-4" />
          {t("billing.savedNarratives.title")}
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-72" side="bottom">
          <ScrollArea className="max-h-72">
            {savedQuery.isPending && (
              <div className="flex h-11 items-center px-2">
                <Loader label={t("common.loading")} size="sm" />
              </div>
            )}
            {savedQuery.isError && (
              <Button
                onClick={() =>
                  detached(
                    savedQuery.refetch(),
                    "saved-time-narratives.refetch",
                  )
                }
                size="row"
                variant="ghost"
              >
                {t("common.retry")}
              </Button>
            )}
            {savedQuery.isSuccess && items.length === 0 && (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {t("billing.savedNarratives.empty")}
              </p>
            )}
            {items.map((item) => (
              <div className="flex min-w-0 items-center" key={item.id}>
                <Button
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => {
                    onSelect(item.narrative, item.narrativeLanguage);
                    setIsOpen(false);
                  }}
                  size="row"
                  type="button"
                  variant="ghost"
                >
                  <bdi className="truncate">{item.name}</bdi>
                </Button>
                <Button
                  aria-label={t("common.deleteConfirmDescription", {
                    name: isolateName(item.name),
                  })}
                  className="size-11 shrink-0"
                  disabled={remove.isPending}
                  onClick={() => {
                    setIsOpen(false);
                    setDeleting(item);
                  }}
                  size="icon"
                  title={t("common.delete")}
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
            {savedQuery.hasNextPage && (
              <Button
                className="w-full"
                disabled={savedQuery.isFetchingNextPage}
                onClick={() =>
                  detached(
                    savedQuery.fetchNextPage(),
                    "saved-time-narratives.next-page",
                  )
                }
                type="button"
                variant="ghost"
              >
                {savedQuery.isFetchingNextPage ? (
                  <Loader label={t("common.loading")} size="sm" />
                ) : (
                  t("common.loadMore")
                )}
              </Button>
            )}
          </ScrollArea>
        </PopoverPopup>
      </Popover>
      <Button
        aria-label={t("billing.savedNarratives.save")}
        disabled={narrative.trim().length === 0 || create.isPending}
        onClick={() => setName("")}
        size="icon-sm"
        title={t("billing.savedNarratives.save")}
        type="button"
        variant="ghost"
      >
        <BookmarkPlusIcon className="size-4" />
      </Button>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !create.isPending) {
            setName(null);
          }
        }}
        open={name !== null}
      >
        <DialogPopup>
          <DialogFormState
            dirty={name !== null && name !== ""}
            onDiscard={() => {
              setName(null);
            }}
          />
          <DialogHeader>
            <DialogTitle>{t("billing.savedNarratives.save")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmedName = name?.trim();
              if (trimmedName) {
                create.mutate(trimmedName);
              }
            }}
          >
            <div className="px-6 pb-6">
              <label className="sr-only" htmlFor="saved-narrative-name">
                {t("common.name")}
              </label>
              <Input
                autoFocus
                id="saved-narrative-name"
                maxLength={NAME_MAX_LENGTH}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                value={name ?? ""}
              />
            </div>
            <DialogFooter>
              <Button
                onClick={() => setName(null)}
                type="button"
                variant="ghost"
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={!name?.trim() || create.isPending}
                type="submit"
              >
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
          }
        }}
        open={deleting !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.deleteConfirmDescription", {
                name: isolateName(deleting?.name ?? ""),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={!deleting || remove.isPending}
              onClick={() => {
                if (deleting) {
                  remove.mutate(deleting.id);
                }
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
