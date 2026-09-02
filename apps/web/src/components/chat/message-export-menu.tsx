import { useState } from "react";
import type { ComponentProps } from "react";

import { Result } from "better-result";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Popover, PopoverPopup, PopoverTitle } from "@stll/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { prepareCreateDocumentDraft } from "@/components/chat/create-document-draft-runtime";
import {
  buildCreateDocumentDownloadFileName,
  type CreateDocumentDraft,
} from "@/components/chat/create-document-draft.logic";
import { hasMessageExportCitations } from "@/components/chat/message-export-menu.logic";
import { DocumentIcon } from "@/components/document-icon";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
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
  anchor: ComponentProps<typeof PopoverPopup>["anchor"];
  artifact?: CreateDocumentDraft | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  threadRef: ChatThreadRef;
  // Optional only for dev HMR compatibility: an already-mounted child can
  // briefly receive the previous parent's prop shape during a module swap.
  message?: PersistedChatMessage | undefined;
};

const compileArtifactDraft = async (artifact: CreateDocumentDraft) => {
  const { compileCreateDocumentSourceToDocx } =
    await import("@/components/chat/create-document-compiler");
  return await compileCreateDocumentSourceToDocx(artifact.source, {
    titleFallback: artifact.name,
  });
};

export const MessageExportMenu = ({
  anchor,
  artifact,
  onOpenChange,
  open,
  threadRef,
  message,
}: MessageExportMenuProps) => {
  const t = useTranslations();
  const hasCitations =
    message !== undefined && hasMessageExportCitations(message);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>(
    hasCitations ? "footnotes" : "none",
  );
  const [includeMessage, setIncludeMessage] = useState(true);
  const [includeArtifact, setIncludeArtifact] = useState(
    artifact !== undefined,
  );
  const [isExportPending, setIsExportPending] = useState(false);
  const artifactFileName =
    artifact === undefined
      ? undefined
      : buildCreateDocumentDownloadFileName(artifact.name);

  const handleExport = async () => {
    setIsExportPending(true);
    const result = await Result.tryPromise(async () => {
      const downloads: { blob: Blob; fileName: string }[] = [];
      if (includeMessage) {
        if (message === undefined) {
          throw new ClientOperationError({
            action: "export-chat-message",
            message: "Chat message is unavailable during a live update",
          });
        }
        const response = await api.chat
          .threads({ threadId: threadRef.threadId })
          .export.post(
            {
              messageId: toSafeId<"chatMessage">(message.id),
              format: "docx",
              citationStyle: hasCitations ? citationStyle : "none",
            },
            {
              query:
                threadRef.scope === "workspace"
                  ? {
                      workspaceId: toSafeId<"workspace">(threadRef.workspaceId),
                    }
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
        downloads.push({ blob: await file.blob(), fileName });
      }

      if (includeArtifact && artifact !== undefined) {
        const prepared = await prepareCreateDocumentDraft({
          toolCallId: artifact.toolCallId,
          compileFallback: async () => {
            const compiled = await compileArtifactDraft(artifact);
            return compiled.status === "ok" ? compiled.buffer : null;
          },
        });
        let buffer: ArrayBuffer;
        switch (prepared.status) {
          case "failed":
            throw new ClientOperationError({
              action: "export-create-document-draft",
              cause: prepared.error,
              message: "Edited document could not be serialized",
            });
          case "ready":
            buffer = prepared.buffer;
            break;
          case "unavailable":
            throw new ClientOperationError({
              action: "export-create-document-draft",
              message: "Generated document source could not be compiled",
            });
          default:
            buffer = prepared satisfies never;
        }
        downloads.push({
          blob: new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }),
          fileName: buildCreateDocumentDownloadFileName(artifact.name),
        });
      }

      for (const download of downloads) {
        downloadFile(download.blob, download.fileName);
      }
    });
    setIsExportPending(false);

    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("common.export.failed"), type: "error" });
      return;
    }

    onOpenChange(false);
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverPopup
        align="start"
        anchor={anchor}
        className="w-64 p-3"
        side="top"
      >
        <div className="flex flex-col gap-3">
          <PopoverTitle className="text-sm font-medium">
            {t("common.export.title")}
          </PopoverTitle>
          <p className="text-muted-foreground text-xs">
            {t.rich("common.export.formatDocx", {
              docx: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </p>
          {artifact !== undefined && (
            <div className="flex flex-col gap-2 text-xs">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={includeMessage}
                  onCheckedChange={setIncludeMessage}
                />
                <DocumentIcon
                  className="size-4 shrink-0"
                  mimeType={DOCX_MIME}
                />
                <span>{t("common.export.title")}</span>
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={includeArtifact}
                  onCheckedChange={setIncludeArtifact}
                />
                <DocumentIcon
                  className="size-4 shrink-0"
                  fileName={artifactFileName}
                  mimeType={DOCX_MIME}
                />
                <span className="truncate">{artifactFileName}</span>
              </label>
            </div>
          )}
          {includeMessage && hasCitations && (
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
          )}
          <Button
            aria-live="polite"
            disabled={
              isExportPending ||
              message === undefined ||
              (!includeMessage && (artifact === undefined || !includeArtifact))
            }
            onClick={() => {
              detached(handleExport(), "message-export-menu.export");
            }}
            size="sm"
          >
            {isExportPending && (
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            )}
            {isExportPending ? t("common.preparing") : t("common.export.title")}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};
