import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { extensionMatches } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

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
          queryKey: entitiesKeys.all(workspaceId),
          entityId: toSafeId<"entity">(entityId),
          file,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: () => {
      stellaToast.add({
        title: t("workspaces.files.versionUploaded"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.versionUploadFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });
};
