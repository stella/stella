import { useState } from "react";

import { Result } from "better-result";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import { CsvIcon, DocxIcon, XlsxIcon } from "@/components/document-icon";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import { ClientOperationError } from "@/lib/errors/client";
import { getExportFileName } from "@/lib/export-download";
import { fetchWithTimeout } from "@/lib/fetch";
import { downloadFile } from "@/lib/utils";

const REVIEW_EXPORT_FORMATS = ["xlsx", "docx", "csv"] as const;
type ReviewExportFormat = (typeof REVIEW_EXPORT_FORMATS)[number];

// TODO(i18n): English until the review surface is localized as a whole.
const EXPORT_LABEL = "Export";
const EXPORTING_LABEL = "Exporting";
// The server names the file after the reviewed document; this only covers a
// response without a `Content-Disposition` name.
const FALLBACK_FILE_STEM = "review-issues";
const FORMAT_LABEL = {
  xlsx: "Excel (.xlsx)",
  docx: "Word (.docx)",
  csv: "CSV",
} as const satisfies Record<ReviewExportFormat, string>;
const FORMAT_ICON = {
  xlsx: XlsxIcon,
  docx: DocxIcon,
  csv: CsvIcon,
} as const satisfies Record<ReviewExportFormat, typeof CsvIcon>;

const EXPORT_TIMEOUT_MS = 60_000;

type ReviewExportMenuProps = {
  workspaceId: string;
  runId: string;
};

/** Downloads a finished review as an issues table in one of three formats. */
export const ReviewExportMenu = ({
  workspaceId,
  runId,
}: ReviewExportMenuProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [pendingFormat, setPendingFormat] = useState<ReviewExportFormat | null>(
    null,
  );

  const handleExport = async (format: ReviewExportFormat) => {
    setPendingFormat(format);
    const result = await Result.tryPromise(async () => {
      const url = new URL(
        apiUrl(
          `/workspaces/${workspaceId}/document-reviews/runs/${runId}/export`,
        ),
      );
      url.searchParams.set("format", format);
      const response = await fetchWithTimeout(url, {
        credentials: "include",
        timeoutMs: EXPORT_TIMEOUT_MS,
      });
      if (!response.ok) {
        throw new ClientOperationError({
          action: "exportReviewIssues",
          message: "Failed to export review issues",
        });
      }
      return {
        blob: await response.blob(),
        fileName:
          getExportFileName(response.headers.get("Content-Disposition")) ??
          `${FALLBACK_FILE_STEM}.${format}`,
      };
    });
    setPendingFormat(null);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        title: t("workspaces.views.exportFailed"),
        type: "error",
      });
      return;
    }
    downloadFile(result.value.blob, result.value.fileName);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={pendingFormat !== null}
            disabled={pendingFormat !== null}
            size="xs"
            variant="outline"
          />
        }
      >
        {pendingFormat === null ? (
          <DownloadIcon className="size-3.5" />
        ) : (
          <Loader label={EXPORTING_LABEL} size="sm" />
        )}
        {EXPORT_LABEL}
      </MenuTrigger>
      <MenuPopup className="min-w-44">
        {REVIEW_EXPORT_FORMATS.map((format) => {
          const Icon = FORMAT_ICON[format];
          return (
            <MenuItem
              closeOnClick={false}
              disabled={pendingFormat !== null}
              key={format}
              onClick={() => {
                detached(handleExport(format), "review-export-menu.export");
              }}
            >
              <Icon className="size-4 opacity-100" />
              {FORMAT_LABEL[format]}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
};
