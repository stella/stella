import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatLocalFilesUndoRefusal } from "@stll/api-contract/chat-local-files-undo";
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
import type { EntityAction } from "@stll/ui/entity-actions";
import { CheckIcon, Undo2Icon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import {
  localFilesUndoOptions,
  type LocalFilesUndoTurn,
  requestLocalFilesUndo,
} from "@/features/chat/local-files-undo";
import {
  type LocalFilesUndoView,
  localFilesUndoView,
} from "@/features/chat/local-files-undo.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** The member's last refused request, for the turn it was asked on. */
type Refusal = { turnId: string; reason: ChatLocalFilesUndoRefusal };

/** A turn nobody can undo here: its read never runs. */
const NO_TURN: LocalFilesUndoTurn = {
  activeOrganizationId: "",
  userId: "",
  threadId: "",
  turnId: "",
};

/**
 * Undo of the file changes the newest turn of a chat made on the member's
 * computer, for that turn's message row: the action for its actions list,
 * and the row's confirmation and status. `turnId` is `null` on every other
 * message, which offers nothing and reads nothing.
 */
export const useLocalFilesUndo = ({
  threadId,
  turnId,
  undone,
}: {
  threadId: string;
  turnId: string | null;
  /** The page read this turn as undone: it keeps the marker regardless. */
  undone: boolean;
}): { actions: EntityAction[]; extras: ReactNode } => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const turn: LocalFilesUndoTurn | null =
    turnId === null || user === null
      ? null
      : {
          activeOrganizationId: user.activeOrganizationId,
          userId: user.id,
          threadId,
          turnId,
        };
  const options = localFilesUndoOptions(turn ?? NO_TURN);
  const readView = queryView(useQuery({ ...options, enabled: turn !== null }));
  useQueryViewError(readView, "LocalFilesUndo:query");

  const undo = useIdempotentMutation({
    idempotencyScope: `chat.${threadId}.${turnId ?? "none"}.undo-local-files`,
    mutationFn: async () =>
      await requestLocalFilesUndo(
        turn ?? panic("An undo is asked only on a turn that offers it"),
      ),
    onSuccess: async (answer) => {
      setConfirming(false);
      setRefusal(
        answer.type === "refused" && turnId !== null
          ? { turnId, reason: answer.reason }
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: options.queryKey });
    },
    onError: (error) => {
      setConfirming(false);
      getAnalytics().captureError(error, {
        fingerprintKey: "LocalFilesUndo:failure",
        scope: { type: "handler", handlerId: "LocalFilesUndo:failure" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  if (turn === null) {
    return {
      actions: [],
      extras: undone ? (
        <LocalFilesUndoStatus status={{ type: "restored" }} />
      ) : null,
    };
  }
  const view = localFilesUndoView({
    // A read that failed or has not arrived offers nothing yet.
    read: readView.type === "items" ? readView.items : undefined,
    refusal: refusal?.turnId === turn.turnId ? refusal.reason : null,
  });
  // The page already read this turn as undone: the marker shows before the
  // turn's own read arrives.
  const shown: LocalFilesUndoView =
    undone && view.status.type === "none"
      ? { canUndo: false, status: { type: "restored" } }
      : view;
  const actions: EntityAction[] = shown.canUndo
    ? [
        {
          disabled: undo.isPending,
          icon: <Undo2Icon aria-hidden="true" />,
          label: t("chat.localFilesUndo.action"),
          onClick: () => setConfirming(true),
        },
      ]
    : [];
  return {
    actions,
    extras: (
      <>
        <LocalFilesUndoStatus status={shown.status} />
        <AlertDialog
          onOpenChange={(open) => {
            if (!undo.isPending) {
              setConfirming(open);
            }
          }}
          open={confirming}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("chat.localFilesUndo.confirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("chat.localFilesUndo.confirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                disabled={undo.isPending}
                render={<Button variant="outline" />}
              >
                {t("common.cancel")}
              </AlertDialogClose>
              <Button
                loading={undo.isPending}
                onClick={() => {
                  undo.mutate();
                }}
                variant="destructive"
              >
                {t("chat.localFilesUndo.confirm")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </>
    ),
  };
};

/** The line beside the turn's actions: the undo on its way, done, or not. */
const LocalFilesUndoStatus = ({
  status,
}: {
  status: LocalFilesUndoView["status"];
}) => {
  const t = useTranslations();
  switch (status.type) {
    case "none":
      return null;
    case "pending":
      return (
        <span
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
        >
          <Loader label={t("chat.localFilesUndo.pending")} size="sm" />
          {t("chat.localFilesUndo.pending")}
        </span>
      );
    case "restored":
      return (
        <span
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          data-local-files-undo="restored"
          role="status"
        >
          <CheckIcon aria-hidden="true" className="size-3.5" />
          {t("chat.localFilesUndo.restored")}
        </span>
      );
    case "problem":
      return (
        <span className="text-muted-foreground text-xs" role="status">
          {t(status.messageKey)}
        </span>
      );
    default:
      status satisfies never;
      return panic("Unhandled local files undo status");
  }
};
