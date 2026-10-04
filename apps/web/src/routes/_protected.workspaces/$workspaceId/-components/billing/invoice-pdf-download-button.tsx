import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "use-intl";

import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";

import { useLocale as useFormattingLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
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
  const locale = useLocale();
  const formattingLocale = useFormattingLocale();
  const analytics = useAnalytics();
  const download = useMutation({
    mutationFn: async () => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .pdf.post(
          {},
          {
            headers: {
              "Accept-Language": locale,
              "x-stella-formatting-locale": formattingLocale,
            },
            fetch: { signal: AbortSignal.timeout(PDF_DOWNLOAD_TIMEOUT_MS) },
          },
        );
      const { downloadUrl, fileName } = unwrapEden(response);
      const file = await fetchWithTimeout(downloadUrl, {
        timeoutMs: PDF_DOWNLOAD_TIMEOUT_MS,
      });
      if (!file.ok) {
        unwrapEden({
          data: null,
          error: { status: file.status, value: "Invoice PDF download failed" },
        });
      }
      const blob = await file.blob();
      downloadFile(blob, fileName);
    },
    onError: (error) => {
      analytics.captureError(error);
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
