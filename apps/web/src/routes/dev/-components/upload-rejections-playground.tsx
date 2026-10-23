import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { toAPIError } from "@/lib/errors/api";
import { uploadFailureDisposition } from "@/lib/upload-queue";
import { buildEntityCreatePresignPayload } from "@/lib/workspaces/mutations/create-file-upload-payload.logic";
import { showUploadFailureToast } from "@/lib/workspaces/mutations/upload-failure-toast";

export const UploadRejectionsPlayground = () => {
  const t = useTranslations();
  const showFailures = () => {
    const prepared = buildEntityCreatePresignPayload({
      propertyId: "visual-upload-property",
      name: "empty.pdf",
      mimeType: "application/pdf",
      size: 0,
      sha256Hex:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    // The old producer sends size zero and receives this schema rejection;
    // the current producer rejects the same input locally before presign.
    const emptyError = prepared.isErr()
      ? prepared.error
      : toAPIError({ status: 422, value: { message: "Invalid request" } });
    const securityError = toAPIError({
      status: 422,
      value: {
        code: "file_security_rejected",
        message: "File rejected by security check",
      },
    });
    const props = {
      toastId: stellaToast.loading(t("workspaces.files.uploading")),
      title: t("workspaces.files.uploadedPartially", { failed: 2, total: 3 }),
      type: "warning",
      failures: [
        {
          file: new File([], "empty.pdf"),
          error: emptyError,
          disposition: uploadFailureDisposition(emptyError),
        },
        {
          file: new File(["content"], "wrong.pdf"),
          error: securityError,
          disposition: uploadFailureDisposition(securityError),
        },
      ],
      labels: {
        reasonFallback: t("errors.uploadFailed"),
        additionalFailures: (count) =>
          t("chat.historyContext.unnamed", { count }),
        retryFailed: (count) => t("workspaces.files.retryFailed", { count }),
      },
      onRetry: () => undefined,
    } satisfies Parameters<typeof showUploadFailureToast>[0];
    showUploadFailureToast(props);
  };
  return (
    <section className="p-4" data-playground-section="upload-rejections">
      <Button onClick={showFailures}>Show upload failures</Button>
    </section>
  );
};
