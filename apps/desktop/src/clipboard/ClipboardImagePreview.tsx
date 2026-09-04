import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";

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
  surface: ClipboardImagePreviewSurface;
};

export const ClipboardImagePreview = ({
  alt,
  className,
  id,
  surface,
}: ClipboardImagePreviewProps) => {
  const [preview, setPreview] = useState<{
    dataUrl: string;
    id: string;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    void invoke<unknown>("clipboard_get_image_preview", { id })
      .then((value) => {
        if (!isClipboardImagePreviewDataUrl(value)) {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
            ...PREVIEW_TELEMETRY[surface],
          });
          return undefined;
        }
        if (!disposed) {
          setPreview({ dataUrl: value, id });
        }
        return undefined;
      })
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          ...PREVIEW_TELEMETRY[surface],
        });
      });
    return () => {
      disposed = true;
    };
  }, [id, surface]);
  const previewDataUrl = preview?.id === id ? preview.dataUrl : null;

  if (!previewDataUrl) {
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
      src={previewDataUrl}
    />
  );
};
