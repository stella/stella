import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";

import { useFormattingLocale } from "@/i18n/formatting-context";
import { useMessageLocale } from "@/i18n/message-locale";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;

type InvoicePdfDownloadButtonProps = {
  workspaceId: string;
  invoiceId: string;
};

export const InvoicePdfDownloadButton = ({
  workspaceId,
  invoiceId,
}: InvoicePdfDownloadButtonProps) => {
  const t = useTranslations();
  const messageLocale = useMessageLocale();
  const formattingLocale = useFormattingLocale();
  const analytics = useAnalytics();
  const requestPdf = async () => {
    const response = await invokeCapability(
      "invoices.pdf.export",
      async (request) =>
        api
          .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
            invoiceId: toSafeId<"invoice">(invoiceId),
          })
          .pdf.post(
            {},
            {
              ...request,
              headers: {
                "Accept-Language": messageLocale,
                "x-stella-formatting-locale": formattingLocale,
                ...request.headers,
              },
              fetch: { signal: AbortSignal.timeout(PDF_DOWNLOAD_TIMEOUT_MS) },
            },
          ),
    );
    return unwrapApiResponse(response);
  };
  const download = useMutation({
    mutationFn: async () => {
      const { downloadUrl, fileName } = await requestPdf();
      const file = await fetchWithTimeout(downloadUrl, {
        timeout: { type: "idle", ms: PDF_DOWNLOAD_TIMEOUT_MS },
      });
      if (!file.ok) {
        unwrapApiResponse({
          data: null,
          error: { status: file.status, value: "Invoice PDF download failed" },
        });
      }
      const blob = await file.blob();
      downloadFile(blob, fileName);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "InvoicePdfDownloadButton:failure",
        scope: {
          type: "handler",
          handlerId: "InvoicePdfDownloadButton:failure",
        },
      });
      notifyUserError(error, t("workspaces.views.exportFailed"));
    },
  });

  return (
    <Button
      aria-busy={download.isPending}
      disabled={download.isPending}
      loading={download.isPending}
      onClick={() => download.mutate()}
      size="sm"
      variant="outline"
    >
      <DownloadIcon className="size-3.5" />
      {t("templates.downloadPdf")}
    </Button>
  );
};
