import { useState } from "react";
import type { PropsWithChildren } from "react";

import { useObservedValue } from "@stll/ui/effects-dom";

import type { ViewerSurface } from "@/components/viewer/recoverable-viewer-boundary";
import { PDFProvider } from "@/lib/pdf/pdf-context";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";

export type MeasuredPdfProviderProps = PropsWithChildren<{
  active: boolean;
  fallback?: PDFPageFallback | undefined;
  fieldId: string;
  initialScaleOffset: number;
  surface: ViewerSurface;
  onDownload?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}>;

export const MeasuredPdfProvider = ({
  active,
  children,
  fallback,
  fieldId,
  initialScaleOffset,
  onDownload,
  onError,
  surface,
}: MeasuredPdfProviderProps) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  // The first width the active container reports, kept once taken: the
  // observer stops at it, and an inactive container is not measured.
  const initialFitWidth = useObservedValue<HTMLDivElement, number | undefined>(
    container,
    (node, emit) => {
      if (!active) {
        return () => undefined;
      }
      const updateWidth = (width: number) => {
        if (width <= 0) {
          return false;
        }
        emit(width);
        return true;
      };
      if (updateWidth(node.clientWidth)) {
        return () => undefined;
      }
      const observer = new ResizeObserver((entries) => {
        const entry = entries.at(-1);
        if (entry && updateWidth(entry.contentRect.width)) {
          observer.disconnect();
        }
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
      };
    },
    [active],
    undefined,
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" ref={setContainer}>
      {initialFitWidth === undefined ? (
        (fallback?.suspense ?? null)
      ) : (
        <PDFProvider
          fieldId={fieldId}
          fitToWidth={initialFitWidth}
          initialScaleOffset={initialScaleOffset}
          startPage={1}
          fallback={fallback}
          onDownload={onDownload}
          onError={onError}
          surface={surface}
        >
          {children}
        </PDFProvider>
      )}
    </div>
  );
};
