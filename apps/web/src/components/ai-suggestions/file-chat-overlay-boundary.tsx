import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { RecoverableErrorStatus } from "@/components/recoverable-error-status";

type FileChatOverlayErrorFallbackProps = {
  error: Error;
  onDismiss: () => void;
  onRetry: () => void;
};

/**
 * Says which part of the page failed. A chunk removed by a deploy cannot be
 * fetched again by the old page, so that case offers a reload; anything else
 * offers a fresh attempt. The chat is optional, so the bar can always be
 * dismissed and leave the document readable without it.
 */
export const FileChatOverlayErrorFallback = ({
  error: _error,
  onDismiss,
  onRetry,
}: FileChatOverlayErrorFallbackProps) => {
  const t = useTranslations();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <RecoverableErrorStatus
        className="bg-background/95 pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 shadow-sm"
        message={t("chat.overlayLoadFailed")}
        messageClassName="text-muted-foreground text-sm"
        actions={
          <>
            <Button onClick={onRetry} size="sm" variant="outline">
              {t("common.tryAgain")}
            </Button>
            <Button
              aria-label={t("common.dismiss")}
              onClick={onDismiss}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </Button>
          </>
        }
      />
    </div>
  );
};

type FileChatOverlayBoundaryProps = {
  area: string;
  children: ReactNode;
  /** The document the overlay belongs to; a dismissal holds for it. */
  overlayKey: string;
  /** Prepare a fresh attempt before the boundary re-renders its children. */
  onRetry: () => void;
};

/**
 * Error boundary for the optional chat overlay. A failure is named, and once
 * dismissed the overlay stays unmounted for that document, so the reader
 * underneath keeps working without it.
 */
export const FileChatOverlayBoundary = ({
  area,
  children,
  overlayKey,
  onRetry,
}: FileChatOverlayBoundaryProps) => {
  const [dismissedOverlayKeys, setDismissedOverlayKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());

  if (dismissedOverlayKeys.has(overlayKey)) {
    return null;
  }

  return (
    <QuerySuspenseBoundary
      area={area}
      errorFallback={({ reset, error }) => (
        <FileChatOverlayErrorFallback
          error={error}
          onDismiss={() => {
            setDismissedOverlayKeys((keys) => new Set(keys).add(overlayKey));
          }}
          onRetry={() => {
            onRetry();
            reset();
          }}
        />
      )}
      resetKeys={[overlayKey]}
      suspenseFallback={null}
    >
      {children}
    </QuerySuspenseBoundary>
  );
};
