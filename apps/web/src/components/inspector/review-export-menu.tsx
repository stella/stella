import { useState } from "react";

import { Result } from "better-result";
import { DownloadIcon, SendIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import { CsvIcon, DocxIcon, XlsxIcon } from "@/components/document-icon";
import { downloadTabOriginalFile } from "@/components/inspector/file-download-service";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import { ClientOperationError } from "@/lib/errors/client";
import { getExportFileName } from "@/lib/export-download";
import { fetchWithTimeout } from "@/lib/fetch";
import { downloadFile } from "@/lib/utils";

/**
 * Who an export is for.
 *
 * The two are different documents, not two formats of one: the internal memo
 * is the review record — findings, rationale, references, flags — and the
 * counterparty file is the contract itself. Naming the audience is what keeps
 * a reviewer from sending the first when they meant the second.
 */
const EXPORT_AUDIENCE = {
  INTERNAL: "internal",
  COUNTERPARTY: "counterparty",
} as const;
type ExportAudience = (typeof EXPORT_AUDIENCE)[keyof typeof EXPORT_AUDIENCE];

const REVIEW_EXPORT_FORMATS = ["xlsx", "docx", "csv"] as const;
type ReviewExportFormat = (typeof REVIEW_EXPORT_FORMATS)[number];

/** What is being prepared, or `null` when nothing is. A discriminated union
 *  rather than two booleans: only one download runs at a time, and the
 *  internal one also has to say which format. */
type PendingExport =
  | { audience: typeof EXPORT_AUDIENCE.INTERNAL; format: ReviewExportFormat }
  | { audience: typeof EXPORT_AUDIENCE.COUNTERPARTY };

const AUDIENCE_LABEL_KEYS = {
  internal: "inspector.review.export.internal",
  counterparty: "inspector.review.export.counterparty",
} as const satisfies Record<ExportAudience, TranslationKey>;
// The server names the file after the reviewed document; this only covers a
// response without a `Content-Disposition` name.
const FALLBACK_FILE_STEM = "review-issues";
const FORMAT_LABEL_KEYS = {
  xlsx: "inspector.review.export.xlsx",
  docx: "inspector.review.export.docx",
  csv: "inspector.review.export.csv",
} as const satisfies Record<ReviewExportFormat, TranslationKey>;
const FORMAT_ICON = {
  xlsx: XlsxIcon,
  docx: DocxIcon,
  csv: CsvIcon,
} as const satisfies Record<ReviewExportFormat, typeof CsvIcon>;

const EXPORT_TIMEOUT_MS = 60_000;

/**
 * The document a "Send to counterparty" export produces, and nothing else.
 *
 * Deliberately only the field the document lives on and the name to save it
 * under: the reviewed document's current version, carrying the tracked changes
 * and the notes the reviewer typed into it, straight from storage. No run, no
 * finding, no basis is in scope here, so no rationale, reference quote or flag
 * can reach the counterparty even by accident — the review record has no path
 * into these bytes.
 */
export type CounterpartyExportTarget = {
  /** The file field holding the reviewed document. */
  fileFieldId: string;
  /** What to save it as. Falls back to the field's own name when empty. */
  fileName: string;
};

type ReviewExportMenuProps = {
  workspaceId: string;
  runId: string;
  /** `null` while the reviewed document is not resolvable (a restored run
   *  whose version has not loaded); the counterparty item then explains
   *  itself rather than disappearing. */
  counterparty: CounterpartyExportTarget | null;
};

/** Downloads a finished review, named by who is going to read it. */
export const ReviewExportMenu = ({
  workspaceId,
  runId,
  counterparty,
}: ReviewExportMenuProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [pending, setPending] = useState<PendingExport | null>(null);

  const handleInternalExport = async (format: ReviewExportFormat) => {
    setPending({ audience: EXPORT_AUDIENCE.INTERNAL, format });
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
    setPending(null);

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

  // The same download the inspector header offers, reached from the review so
  // the reviewer does not have to leave it. It takes the document reference
  // and nothing from the run.
  const handleCounterpartyExport = async (target: CounterpartyExportTarget) => {
    setPending({ audience: EXPORT_AUDIENCE.COUNTERPARTY });
    await downloadTabOriginalFile({
      fieldId: target.fileFieldId,
      fileName: target.fileName,
      workspaceId,
      onError: (message) => {
        stellaToast.add({
          title: t("inspector.review.export.counterpartyFailed"),
          description: message,
          type: "error",
        });
      },
    });
    setPending(null);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={pending !== null}
            disabled={pending !== null}
            size="xs"
            variant="outline"
          />
        }
      >
        {pending === null ? (
          <DownloadIcon className="size-3.5" />
        ) : (
          <Loader label={t("inspector.review.export.exporting")} size="sm" />
        )}
        {t("clauses.export")}
      </MenuTrigger>
      <MenuPopup className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>
            {t(AUDIENCE_LABEL_KEYS.internal)}
            <span className="text-muted-foreground block text-xs font-normal">
              {t("inspector.review.export.internalHint")}
            </span>
          </MenuGroupLabel>
          {REVIEW_EXPORT_FORMATS.map((format) => {
            const Icon = FORMAT_ICON[format];
            return (
              <MenuItem
                closeOnClick={false}
                disabled={pending !== null}
                key={format}
                onClick={() => {
                  detached(
                    handleInternalExport(format),
                    "review-export-menu.export",
                  );
                }}
              >
                <Icon className="size-4 opacity-100" />
                {t(FORMAT_LABEL_KEYS[format])}
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>
            {t(AUDIENCE_LABEL_KEYS.counterparty)}
            <span className="text-muted-foreground block text-xs font-normal">
              {counterparty === null
                ? t("inspector.review.export.counterpartyUnavailable")
                : t("inspector.review.export.counterpartyHint")}
            </span>
          </MenuGroupLabel>
          <MenuItem
            closeOnClick={false}
            disabled={pending !== null || counterparty === null}
            onClick={() => {
              if (counterparty !== null) {
                detached(
                  handleCounterpartyExport(counterparty),
                  "review-export-menu.counterparty",
                );
              }
            }}
          >
            <SendIcon className="size-4 opacity-100" />
            {t(AUDIENCE_LABEL_KEYS.counterparty)}
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};
