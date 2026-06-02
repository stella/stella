import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

import { PDFProvider } from "@/lib/pdf/pdf-context";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";

export type MeasuredPdfProviderProps = PropsWithChildren<{
  active: boolean;
  fallback?: PDFPageFallback | undefined;
  fieldId: string;
  initialScaleOffset: number;
  onError?: ((error: Error) => void) | undefined;
}>;

export const MeasuredPdfProvider = ({
  active,
  children,
  fallback,
  fieldId,
  initialScaleOffset,
  onError,
}: MeasuredPdfProviderProps) => {
  const [initialFitWidth, setInitialFitWidth] = useState<number | undefined>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || initialFitWidth !== undefined) {
      return undefined;
    }

    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const updateWidth = (width: number) => {
      if (width > 0) {
        setInitialFitWidth(width);
      }
    };

    updateWidth(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      updateWidth(entry.contentRect.width);
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [active, initialFitWidth]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" ref={containerRef}>
      {initialFitWidth === undefined ? (
        (fallback?.suspense ?? null)
      ) : (
        <PDFProvider
          fieldId={fieldId}
          fitToWidth={initialFitWidth}
          initialScaleOffset={initialScaleOffset}
          startPage={1}
          fallback={fallback}
          onError={onError}
        >
          {children}
        </PDFProvider>
      )}
    </div>
  );
};
