import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "use-intl";

import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { useLocale as useFormattingLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { unwrapEden } from "@/lib/errors/api";
import { getExportBaseName, getExportFileName } from "@/lib/export-download";
import { downloadFile } from "@/lib/utils";

const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;

type InvoicePdfDownloadButtonProps = {
  workspaceId: string;
  invoiceId: string;
  invoiceNumber: string | null;
};

export const InvoicePdfDownloadButton = ({
  workspaceId,
  invoiceId,
  invoiceNumber,
}: InvoicePdfDownloadButtonProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const formattingLocale = useFormattingLocale();
  const analytics = useAnalytics();
  const download = useMutation({
    mutationFn: async () => {
      const response = await fetchWithTimeout(
        apiUrl(
          `/invoices/${encodeURIComponent(workspaceId)}/${encodeURIComponent(invoiceId)}/pdf`,
        ),
        {
          credentials: "include",
          headers: {
            "Accept-Language": locale,
            "x-stella-formatting-locale": formattingLocale,
          },
          timeoutMs: PDF_DOWNLOAD_TIMEOUT_MS,
        },
      );
      if (!response.ok) {
        unwrapEden({
          data: null,
          error: { status: response.status, value: await response.text() },
        });
      }
      const blob = await response.blob();
      const fileName =
        getExportFileName(response.headers.get("Content-Disposition")) ??
        `${getExportBaseName(invoiceNumber ?? invoiceId)}.pdf`;
      downloadFile(blob, fileName);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.views.exportFailed"),
        type: "error",
      });
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
