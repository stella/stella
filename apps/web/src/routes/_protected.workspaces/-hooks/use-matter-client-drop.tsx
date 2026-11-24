import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { stellaToast } from "@stll/ui/toast";

import { notifyUserError } from "@/lib/errors/user-toast";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import type { AcceptedMatterClientDrop } from "@/routes/_protected.workspaces/-components/matter-client-drop.logic";

// Applies a matter card dropped on another client's group at once: a client
// never changes who can see the matter, so there is nothing to confirm. Only
// a move offers Undo; a promoted matter cannot go back to having no client.
export const useMatterClientDrop = () =>
  useMatterClientDropState(useUpdateWorkspace());

type MatterClientDropMutation = Pick<
  ReturnType<typeof useUpdateWorkspace>,
  "mutate"
>;

export const useMatterClientDropState = (
  updateWorkspace: MatterClientDropMutation,
) => {
  const t = useTranslations();

  const onMatterDrop = (drop: AcceptedMatterClientDrop) => {
    updateWorkspace.mutate(
      {
        workspaceId: drop.matterId,
        update: {
          type: "clientId",
          value: drop.clientId,
          expectedClientId: drop.type === "move" ? drop.previousClientId : null,
        },
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
            action:
              drop.type === "move"
                ? {
                    label: t("common.undo"),
                    onClick: () => {
                      updateWorkspace.mutate(
                        {
                          workspaceId: drop.matterId,
                          update: {
                            type: "clientId",
                            value: drop.previousClientId,
                            expectedClientId: drop.clientId,
                          },
                        },
                        {
                          onError: (error) => {
                            notifyUserError(error, t("errors.actionFailed"));
                          },
                        },
                      );
                    },
                  }
                : undefined,
          });
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  return { onMatterDrop };
};
