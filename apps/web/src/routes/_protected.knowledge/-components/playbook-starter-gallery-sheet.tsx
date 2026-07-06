import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";
import {
  knowledgeKeys,
  playbookStartersOptions,
} from "@/routes/_protected.knowledge/-queries";

export type PlaybookStarterCreated = {
  id: string;
};

// Mirrors the backend's closed `STARTER_PLAYBOOK_IDS` union
// (apps/api/src/handlers/playbooks/starters.ts) so the mutation input stays a
// literal union instead of widening to `string`.
type StarterId = "nda" | "dpa" | "msa";

type PlaybookStarterGallerySheetProps = {
  onCreated: (playbook: PlaybookStarterCreated) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organizationId: string;
};

export const PlaybookStarterGallerySheet = (
  props: PlaybookStarterGallerySheetProps,
) => (
  <Dialog onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <PlaybookStarterGallerySheetBody {...props} /> : null}
  </Dialog>
);

const SKELETON_ROW_KEYS = ["a", "b", "c"];

const PlaybookStarterGallerySheetBody = ({
  onCreated,
  onOpenChange,
  organizationId,
}: PlaybookStarterGallerySheetProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(playbookStartersOptions(organizationId));
  const starters = data?.items ?? [];

  const create = useMutation({
    mutationFn: async (starterId: StarterId) => {
      const response = await api.playbooks["from-starter"].post({
        starterId,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { id: response.data.id };
    },
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(organizationId),
      });
      stellaToast.add({
        title: t("knowledge.playbooks.starters.addedToast"),
        type: "success",
      });
      onCreated({ id });
      onOpenChange(false);
    },
    onError: (error) => {
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  const pendingId = create.isPending ? create.variables : undefined;

  return (
    <DialogPopup className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t("knowledge.playbooks.starters.title")}</DialogTitle>
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.starters.subtitle")}
        </p>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-3">
        {isLoading &&
          SKELETON_ROW_KEYS.map((key) => (
            <Skeleton className="h-16 w-full rounded-lg" key={key} />
          ))}

        {!isLoading &&
          starters.map((starter) => (
            <button
              className="border-border hover:border-foreground/30 hover:bg-muted/40 flex items-start justify-between gap-3 rounded-lg border p-4 text-start transition-colors disabled:opacity-60"
              disabled={create.isPending}
              key={starter.starterId}
              onClick={() => create.mutate(starter.starterId)}
              type="button"
            >
              <span className="flex flex-col gap-1">
                <span className="text-foreground text-sm font-medium">
                  {starter.name}
                </span>
                <span className="text-muted-foreground text-sm">
                  {starter.description}
                </span>
                <span className="text-muted-foreground mt-1 text-xs">
                  {t("knowledge.playbooks.starters.positionCount", {
                    count: starter.positionCount,
                  })}
                </span>
              </span>
              <span className="text-foreground shrink-0 text-sm font-medium">
                {pendingId === starter.starterId ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  t("common.add")
                )}
              </span>
            </button>
          ))}
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
      </DialogFooter>
    </DialogPopup>
  );
};
