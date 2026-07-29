import { useState } from "react";

import { Result } from "better-result";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

type CitationStyle = "footnotes" | "inline" | "none";

// Static menu config, evaluated once at module load: opening the popover never
// fires a request. Labels are typed as TranslationKey so a stale key fails
// typecheck.
const CITATION_STYLE_OPTIONS = [
  { value: "footnotes", labelKey: "common.export.footnotes" },
  { value: "inline", labelKey: "common.export.inline" },
  { value: "none", labelKey: "common.none" },
] as const satisfies readonly {
  value: CitationStyle;
  labelKey: TranslationKey;
}[];

// Cap the time spent pulling the presigned document before failing closed, so a
// stalled object-store fetch surfaces an error instead of hanging.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// DOCX generation happens synchronously before the API returns its presigned
// download URL. Allow time for a substantial document, but still release the
// pending state and surface the existing export error when the request stalls.
const EXPORT_REQUEST_TIMEOUT_MS = 130_000;

type MessageExportMenuProps = {
  threadRef: ChatThreadRef;
  messageId: string;
};

export const MessageExportMenu = ({
  threadRef,
  messageId,
}: MessageExportMenuProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [citationStyle, setCitationStyle] =
    useState<CitationStyle>("footnotes");
  const [isExportPending, setIsExportPending] = useState(false);

  const handleExport = async () => {
    setIsExportPending(true);
    const result = await Result.tryPromise(async () => {
      const response = await api.chat
        .threads({ threadId: threadRef.threadId })
        .export.post(
          {
            messageId: toSafeId<"chatMessage">(messageId),
            format: "docx",
            citationStyle,
          },
          {
            query:
              threadRef.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
                : {},
            fetch: {
              signal: AbortSignal.timeout(EXPORT_REQUEST_TIMEOUT_MS),
            },
          },
        );
      const { downloadUrl, fileName } = unwrapEden(response);
      const file = await fetchWithTimeout(downloadUrl, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (!file.ok) {
        throw new APIError({
          status: file.status,
          message: `Export download failed (HTTP ${file.status}).`,
        });
      }
      downloadFile(await file.blob(), fileName);
    });
    setIsExportPending(false);

    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("common.export.failed"), type: "error" });
      return;
    }

    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("common.export.title")}
            className="text-muted-foreground h-6 px-1.5 text-xs"
            size="xs"
            variant="ghost"
          >
            <DownloadIcon className="size-3.5" />
            {t("common.export.title")}
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-64 p-3" side="top">
        <div className="flex flex-col gap-3">
          <PopoverTitle className="text-sm font-medium">
            {t("common.export.title")}
          </PopoverTitle>
          <p className="text-muted-foreground text-xs">
            {t.rich("common.export.formatDocx", {
              docx: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </p>
          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-muted-foreground">
              {t("common.export.citations")}
            </span>
            <Select
              onValueChange={(value) => {
                if (value !== null) {
                  setCitationStyle(value);
                }
              }}
              value={citationStyle}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {CITATION_STYLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <Button
            disabled={isExportPending}
            onClick={() => {
              detached(handleExport(), "MessageExportMenu");
            }}
            size="sm"
          >
            {t("common.export.title")}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};
