import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { ImageIcon, ImageOffIcon, RotateCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { isClipboardImagePreviewDataUrl } from "./clipboard-types";

type ClipboardImagePreviewSurface = "editor" | "timeline";

type ClipboardImagePreviewTelemetry = {
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[keyof typeof DESKTOP_TELEMETRY_OPERATIONS];
  window: (typeof DESKTOP_TELEMETRY_WINDOWS)[keyof typeof DESKTOP_TELEMETRY_WINDOWS];
};

const PREVIEW_TELEMETRY = {
  editor: {
    operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
    window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
  },
  timeline: {
    operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardHistoryRead,
    window: DESKTOP_TELEMETRY_WINDOWS.clipboard,
  },
} as const satisfies Record<
  ClipboardImagePreviewSurface,
  ClipboardImagePreviewTelemetry
>;

type ClipboardImagePreviewProps = {
  alt: string;
  className?: string;
  id: string;
  onStatusChange?: (status: ClipboardImagePreviewStatus) => void;
  retryToken?: number;
  showRetry?: boolean;
  surface: ClipboardImagePreviewSurface;
};

export type ClipboardImagePreviewStatus = "error" | "loading" | "ready";

type ClipboardImagePreviewState =
  | { requestKey: string; type: "error" }
  | { requestKey: string; type: "loading" }
  | { dataUrl: string; requestKey: string; type: "ready" };

export const ClipboardImagePreview = ({
  alt,
  className,
  id,
  onStatusChange,
  retryToken = 0,
  showRetry = false,
  surface,
}: ClipboardImagePreviewProps) => {
  const t = useTranslations("clipboard");
  const [localRetryToken, setLocalRetryToken] = useState(0);
  const requestKey = `${id}:${localRetryToken}:${retryToken}`;
  const [preview, setPreview] = useState<ClipboardImagePreviewState>({
    requestKey,
    type: "loading",
  });

  useEffect(() => {
    let disposed = false;
    void invoke<unknown>("clipboard_get_image_preview", { id })
      .then((value) => {
        if (!isClipboardImagePreviewDataUrl(value)) {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
            ...PREVIEW_TELEMETRY[surface],
          });
          if (!disposed) {
            setPreview({ requestKey, type: "error" });
            onStatusChange?.("error");
          }
          return undefined;
        }
        if (!disposed) {
          setPreview({ dataUrl: value, requestKey, type: "ready" });
          onStatusChange?.("ready");
        }
        return undefined;
      })
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          ...PREVIEW_TELEMETRY[surface],
        });
        if (!disposed) {
          setPreview({ requestKey, type: "error" });
          onStatusChange?.("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, [id, onStatusChange, requestKey, surface]);
  const loadingPreview = {
    requestKey,
    type: "loading",
  } as const satisfies ClipboardImagePreviewState;
  const currentPreview =
    preview.requestKey === requestKey ? preview : loadingPreview;

  if (currentPreview.type === "error") {
    return (
      <div
        className={cn(
          "text-muted-foreground grid size-full place-items-center gap-2 text-center text-xs",
          className,
        )}
        role="status"
      >
        <span className="grid place-items-center gap-2">
          <ImageOffIcon aria-hidden="true" className="size-8" />
          <span>{t("imagePreviewError")}</span>
        </span>
        {showRetry ? (
          <Button
            aria-label={t("retryImagePreview")}
            className="size-11 rounded-full"
            onClick={() => setLocalRetryToken((token) => token + 1)}
            size="icon"
            title={t("retryImagePreview")}
            type="button"
            variant="outline"
          >
            <RotateCcwIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </div>
    );
  }

  if (currentPreview.type === "loading") {
    return (
      <span
        aria-label={alt}
        className={cn(
          "text-muted-foreground/60 grid size-full place-items-center",
          className,
        )}
        role="img"
      >
        <ImageIcon aria-hidden="true" className="size-8" />
      </span>
    );
  }

  return (
    <img
      alt={alt}
      className={cn(
        "size-full object-contain outline outline-black/6",
        className,
      )}
      draggable={false}
      src={currentPreview.dataUrl}
    />
  );
};
