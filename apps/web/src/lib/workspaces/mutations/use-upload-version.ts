import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { prepareAttachedTemplateFile } from "@/lib/files/attached-template-upload";
import { requestAttachedTemplateRemoval } from "@/lib/files/attached-template-upload-store";
import { extensionMatches } from "@/lib/files/file-extension";
import { filesKeys } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";

type UploadVersionVars = {
  workspaceId: string;
  entityId: string;
  /** The existing entity's filename, used for extension validation */
  entityFileName: string | null | undefined;
  file: File;
};

const UPLOAD_VERSION_CANCELLED_ACTION = "upload-version-cancelled";

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
        return Result.err(
          new ClientOperationError({
            action: "upload-version",
            message: t(
              "workspaces.files.versionOrNewFile.extensionMismatchError",
            ),
          }),
        );
      }

      const attachedTemplate = await prepareAttachedTemplateFile(file);
      if (
        attachedTemplate !== null &&
        !(await requestAttachedTemplateRemoval([attachedTemplate]))
      ) {
        return Result.err(
          new ClientOperationError({
            action: UPLOAD_VERSION_CANCELLED_ACTION,
            message: "Upload cancelled before attached-template removal",
          }),
        );
      }
      const fileToUpload = attachedTemplate?.file ?? file;

      return await Result.tryPromise({
        try: async () =>
          unwrapEden(
            await api
              .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
              ["upload-version"].post({
                entityId: toSafeId<"entity">(entityId),
                file: fileToUpload,
              }),
          ),
        catch: (cause) => cause,
      });
    },
    onSuccess: async (result, { workspaceId }) => {
      if (Result.isError(result)) {
        if (
          ClientOperationError.is(result.error) &&
          result.error.action === UPLOAD_VERSION_CANCELLED_ACTION
        ) {
          return;
        }
        analytics.captureError(result.error);
        stellaToast.add({
          title: t("workspaces.files.versionUploadFailed"),
          description: userErrorFromThrown(
            result.error,
            t("errors.actionFailed"),
          ),
          type: "error",
        });
        return;
      }

      stellaToast.add({
        title: t("workspaces.files.versionUploaded"),
        type: "success",
      });
      // The new version replaces the field's bytes; open viewers must not
      // keep serving the previous version's cached buffer for the rest of
      // the client-wide staleTime window.
      await queryClient.invalidateQueries({
        queryKey: filesKeys.contentByFieldId({
          workspaceId,
          fieldId: result.value.fieldId,
        }),
      });
    },
  });
};
