import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import {
  toFactDetailsBody,
  withFactDetails,
} from "@/features/avt/fact-details.logic";
import type { SaveState } from "@/features/avt/save-state.logic";
import { readTargetIds, saveStateOf } from "@/features/avt/save-state.logic";
import type { FactDetails, ListItem } from "@/features/avt/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { legalListItemsOptions } from "@/lib/workspaces/queries/legal-lists";

type ListScope = {
  workspaceId: string;
  listId: string;
};

const factDetailsMutationKey = ({ workspaceId, listId }: ListScope) =>
  ["avt", workspaceId, "fact-details", listId] as const;

type SaveVariables = {
  targetIds: [ListItem["id"]];
  details: FactDetails;
};

type PreviousDetails = { previous: FactDetails | null };

/**
 * Evidential-detail edits on a list's facts. Each edit is its own PUT of the
 * fact's whole detail: the fact shows it at once, the stored detail replaces
 * it on success, and a failure restores the previous detail with a toast.
 */
export const useFactDetailActions = (scope: ListScope) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const itemsKey = legalListItemsOptions(scope.workspaceId, scope.listId)
    .queryKey;
  const mutationKey = factDetailsMutationKey(scope);

  const writeDetails = (
    itemEntityId: ListItem["id"],
    details: FactDetails | null,
  ) => {
    queryClient.setQueryData(itemsKey, (current) =>
      current === undefined
        ? current
        : {
            ...current,
            pages: withFactDetails(current.pages, itemEntityId, details),
          },
    );
  };

  const save = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: async ({ targetIds: [itemEntityId], details }: SaveVariables) =>
      unwrapEden(
        await api
          .lists({ workspaceId: toSafeId<"workspace">(scope.workspaceId) })
          ["item-fact-details"].put(
            toFactDetailsBody({
              listId: toSafeId<"legalList">(scope.listId),
              itemEntityId,
              details,
            }),
          ),
      ),
    onMutate: async ({
      targetIds: [itemEntityId],
      details,
    }): Promise<PreviousDetails> => {
      await queryClient.cancelQueries({ queryKey: itemsKey });
      const previous =
        queryClient
          .getQueryData(itemsKey)
          ?.pages.flatMap((page) => page.items)
          .find((item) => item.id === itemEntityId)?.factDetails ?? null;
      writeDetails(itemEntityId, details);
      return { previous };
    },
    onSuccess: ({ itemEntityId, ...stored }) => {
      writeDetails(itemEntityId, stored);
    },
    onError: (error, { targetIds: [itemEntityId] }, context) => {
      if (context !== undefined) {
        writeDetails(itemEntityId, context.previous);
      }
      analytics.captureError(error);
      stellaToast.add({
        type: "error",
        title: t("avt.save.failedTitle"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  return {
    saveDetails: (itemEntityId: ListItem["id"], details: FactDetails) => {
      save.mutate({ targetIds: [itemEntityId], details });
    },
  };
};

/** The save indicator for one fact, derived from this list's detail PUTs. */
export const useFactSaveState = (
  scope: ListScope,
  itemEntityId: ListItem["id"],
): SaveState => {
  const entries = useMutationState({
    filters: { mutationKey: factDetailsMutationKey(scope) },
    select: (mutation) => ({
      targetIds: readTargetIds(mutation.state.variables),
      status: mutation.state.status,
    }),
  });
  return saveStateOf(entries, itemEntityId);
};
