import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { MatterCombobox } from "@/components/workspaces/matter-combobox";
import type { MatterOption } from "@/components/workspaces/matter-combobox";
import { matterPinSet } from "@/features/case-law/matter-links/pin-set.logic";
import {
  linkDecisionsToMatter,
  matterLinkKeys,
} from "@/features/case-law/matter-links/queries";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

/** As long a note as the link will hold. */
const MATTER_LINK_NOTE_MAX_LENGTH = 2000;

type SaveIntoMatterActionProps = {
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; empty means the whole page is offered. */
  selectedDecisionIds: readonly string[];
};

/**
 * Pin what the reader is looking at into a matter.
 *
 * Picked rows if there are any, the page otherwise — never the result set,
 * which is the corpus and not a working set. Anonymous readers see nothing:
 * there is no matter to pin into.
 */
export const SaveIntoMatterAction = ({
  pageDecisionIds,
  selectedDecisionIds,
}: SaveIntoMatterActionProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const authStatus = useClientAuthStatus();
  const [isOpen, setIsOpen] = useState(false);
  const [matter, setMatter] = useState<MatterOption | null>(null);
  const [note, setNote] = useState("");

  const pinSet = matterPinSet({ pageDecisionIds, selectedDecisionIds });

  const save = useMutation({
    mutationFn: async ({
      decisionIds,
      workspaceId,
    }: {
      decisionIds: readonly string[];
      workspaceId: string;
    }) => {
      const trimmed = note.trim();
      const links = await linkDecisionsToMatter({
        decisionIds,
        note: trimmed.length > 0 ? trimmed : null,
        workspaceId,
      });
      return links.length;
    },
    onSuccess: async (count, { workspaceId }) => {
      setIsOpen(false);
      setNote("");
      stellaToast.add({
        title: t("caseLaw.matterLinks.saved", {
          count,
          matter: matter?.name ?? "",
        }),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: matterLinkKeys.list({ workspaceId }),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
    },
  });

  if (!authStatus.isAuthenticated || pinSet.type === "empty") {
    return null;
  }

  return (
    <>
      <Button
        className="h-7 min-h-0 text-xs"
        onClick={() => setIsOpen(true)}
        size="sm"
        variant="outline"
      >
        <FolderPlusIcon aria-hidden="true" className="size-3.5" />
        {t("caseLaw.matterLinks.save")}
      </Button>

      <Dialog onOpenChange={setIsOpen} open={isOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("caseLaw.matterLinks.saveTitle")}</DialogTitle>
            <DialogDescription>
              {pinSet.type === "selection"
                ? t("caseLaw.matterLinks.saveSelection", {
                    count: pinSet.decisionIds.length,
                  })
                : t("caseLaw.matterLinks.savePage", {
                    count: pinSet.decisionIds.length,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <label
              className="text-muted-foreground text-sm"
              htmlFor="case-law-save-matter"
            >
              {t("common.selectAMatter")}
            </label>
            <MatterCombobox
              activeOrganizationId={authStatus.user.activeOrganizationId}
              id="case-law-save-matter"
              onChange={setMatter}
              value={matter}
            />
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">
                {t("caseLaw.matterLinks.note")}
              </span>
              <Textarea
                maxLength={MATTER_LINK_NOTE_MAX_LENGTH}
                onChange={(event) => setNote(event.currentTarget.value)}
                placeholder={t("caseLaw.matterLinks.notePlaceholder")}
                rows={3}
                value={note}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              disabled={matter === null || save.isPending}
              onClick={() => {
                if (matter === null) {
                  return;
                }
                detached(
                  save.mutateAsync({
                    decisionIds: pinSet.decisionIds,
                    workspaceId: matter.id,
                  }),
                  "case-law.save-into-matter",
                );
              }}
            >
              {t("caseLaw.matterLinks.save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
};
