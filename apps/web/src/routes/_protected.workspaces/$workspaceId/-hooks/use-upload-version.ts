import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { filesKeys } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import { extensionMatches } from "@/routes/_protected.workspaces/$workspaceId/-components/file-extension";

type UploadVersionVars = {
  workspaceId: string;
  entityId: string;
  /** The existing entity's filename, used for extension validation */
  entityFileName: string | null | undefined;
  file: File;
};

export const useUploadVersion = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      entityId,
      entityFileName,
      file,
    }: UploadVersionVars) => {
      // Validate extension match before upload
      if (
        !extensionMatches({
          entityFileName,
          uploadFileName: file.name,
        })
      ) {
        throw new ClientOperationError({
          action: "upload-version",
          message: t(
            "workspaces.files.versionOrNewFile.extensionMismatchError",
          ),
        });
      }

      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["upload-version"].post({
          entityId: toSafeId<"entity">(entityId),
          file,
        });

      return unwrapEden(response);
    },
    onSuccess: async ({ fieldId }, { workspaceId }) => {
      stellaToast.add({
        title: t("workspaces.files.versionUploaded"),
        type: "success",
      });
      // The new version replaces the field's bytes; open viewers must not
      // keep serving the previous version's cached buffer for the rest of
      // the client-wide staleTime window.
      await queryClient.invalidateQueries({
        queryKey: filesKeys.contentByFieldId({ workspaceId, fieldId }),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.versionUploadFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });
};
