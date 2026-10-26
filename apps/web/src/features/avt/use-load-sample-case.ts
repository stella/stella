import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { loadSampleCaseAndOpen } from "@/features/avt/sample-case.logic";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { entityCreateLocalInvalidationKeys } from "@/lib/workspaces/mutations/create-file-upload-payload.logic";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { mergeLayout } from "@/lib/workspaces/view-layout";

export const useLoadSampleCase = ({
  view,
  workspaceId,
}: {
  view: AvtWorkspaceView;
  workspaceId: string;
}) => {
  const submit = useIdempotentSubmit();
  const queryClient = useQueryClient();
  const updateView = useUpdateView(workspaceId);
  const t = useTranslations();
  const listsApi = api.lists({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });

  // Keep the view switch and error notice here: the load button unmounts
  // when the newly committed list replaces the empty state.
  return useMutation({
    mutationKey: ["avt", "sample-case", workspaceId],
    mutationFn: async () =>
      await loadSampleCaseAndOpen({
        load: async () =>
          unwrapApiResponse(
            await submit.run({
              operation: `sample.${workspaceId}.create`,
              body: {
                // Used only when the matter has no file property yet.
                filePropertyName: t("common.documents"),
              },
              send: async (body, request) =>
                listsApi["sample-case"].post(body, request),
            }),
          ),
        openList: async (listId) =>
          await updateView.mutateAsync({
            viewId: view.id,
            layout: mergeLayout(view.layout, { listId }),
          }),
      }),
    onSettled: async () => {
      await Promise.all(
        [
          ...entityCreateLocalInvalidationKeys(workspaceId),
          legalListKeys.all(workspaceId),
        ].map(
          async (queryKey) => await queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error) => {
      notifyUserError(error, t("avt.view.loadSampleFailed"));
    },
  });
};
