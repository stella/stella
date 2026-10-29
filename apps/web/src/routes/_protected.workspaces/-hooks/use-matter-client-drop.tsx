import { useState } from "react";

import { panic } from "better-result";
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
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { notifyUserError } from "@/lib/errors/user-toast";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import type { AcceptedMatterClientDrop } from "@/routes/_protected.workspaces/-components/matter-client-drop.logic";

type PromoteDrop = Extract<AcceptedMatterClientDrop, { type: "promote" }>;

type PromotionDialogState =
  { type: "closed" } | { type: "confirming"; drop: PromoteDrop };

// Applies a matter card dropped on another client's group. Moving between
// clients happens at once; attaching a client to a matter without one waits
// for confirmation and preserves who can see it.
export const useMatterClientDrop = () => {
  const t = useTranslations();
  const updateWorkspace = useUpdateWorkspace();
  const [promotion, setPromotion] = useState<PromotionDialogState>({
    type: "closed",
  });

  const assignClient = (drop: AcceptedMatterClientDrop) => {
    updateWorkspace.mutate(
      {
        workspaceId: drop.matterId,
        update: { type: "clientId", value: drop.clientId },
      },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t.rich("workspaces.parties.movedToClient", {
              bdi: (chunks) => <BidiText>{chunks}</BidiText>,
              clientName: drop.clientName,
              matterName: drop.matterName,
            }),
            type: "success",
          });
          if (drop.type === "promote") {
            setPromotion({ type: "closed" });
          }
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const onMatterDrop = (drop: AcceptedMatterClientDrop) => {
    switch (drop.type) {
      case "move":
        assignClient(drop);
        return;
      case "promote":
        setPromotion({ type: "confirming", drop });
        return;
      default:
        drop satisfies never;
        panic(`Unhandled matter client drop: ${String(drop)}`);
    }
  };

  const promotionDialog = (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && !updateWorkspace.isPending) {
          setPromotion({ type: "closed" });
        }
      }}
      open={promotion.type === "confirming"}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("workspaces.parties.promoteCta")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {promotion.type === "confirming" &&
              t.rich("workspaces.parties.promoteToClientConfirm", {
                bdi: (chunks) => <BidiText>{chunks}</BidiText>,
                clientName: promotion.drop.clientName,
                matterName: promotion.drop.matterName,
              })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={updateWorkspace.isPending}
            render={<Button variant="outline" />}
          >
            {t("common.cancel")}
          </AlertDialogClose>
          <Button
            loading={updateWorkspace.isPending}
            onClick={() => {
              if (promotion.type === "confirming") {
                assignClient(promotion.drop);
              }
            }}
          >
            {t("workspaces.parties.promoteCta")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { onMatterDrop, promotionDialog };
};
