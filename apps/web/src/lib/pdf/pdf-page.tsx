import { Suspense, use, useDeferredValue } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Result } from "better-result";
import { useShallow } from "zustand/react/shallow";

import { Skeleton } from "@stella/ui/components/skeleton";

import { PAGE_ID_ATTRIBUTE, TEXT_LAYER_ATTRIBUTE } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import type { RenderPageResult } from "@/lib/pdf/pdf-context";
import { PDFErrorBoundary } from "@/lib/pdf/pdf-error-boundary";

export type PDFPageFallback = {
  suspense?: ReactNode | undefined;
  error?: ReactNode | undefined;
};

export type PDFPageProps = {
  pageId: string;
  /** Render function instead of ReactNode so the
   *  reference stays stable across parent re-renders,
   *  letting PDFPage skip unnecessary renders. */
  renderOverlay?: ((pageId: string) => ReactNode) | undefined;
  fallback?: PDFPageFallback | undefined;
};

export const PDFPage = ({ pageId, renderOverlay, fallback }: PDFPageProps) => {
  const [page, scrollTo, setScrollTo, isActive, renderPromise] = usePDFStore(
    useShallow((s) => [
      s.pages.get(pageId),
      s.scrollTo,
      s.setScrollTo,
      s.activePages.includes(pageId),
      s.renderPromises.get(pageId),
    ]),
  );
  const deferredPromise = useDeferredValue(renderPromise);

  if (!page) {
    return null;
  }

  return (
    <div
      ref={(el) => {
        const shouldScrollToPage =
          scrollTo !== null &&
          scrollTo.target === undefined &&
          scrollTo.pageId === pageId;

        if (!el || !shouldScrollToPage) {
          return;
        }
        el.scrollIntoView({ block: "start" });
        setScrollTo(null);
      }}
      {...{ [PAGE_ID_ATTRIBUTE]: pageId }}
      className="relative mx-auto border-transparent"
      style={
        {
          "--total-scale-factor": "var(--scale-factor)",
          width: `round(down, var(--total-scale-factor) * ${page?.originalWidth ?? 0}px, var(--scale-round-x))`,
          height: `round(down, var(--total-scale-factor) * ${page?.originalHeight ?? 0}px, var(--scale-round-y))`,
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        } as CSSProperties
      }
    >
      <PDFErrorBoundary fallback={fallback?.error ?? null}>
        <Suspense fallback={fallback?.suspense ?? <PDFPageSkeleton />}>
          {isActive && deferredPromise && (
            <>
              <PDFPageContent pageId={pageId} renderPromise={deferredPromise} />
              {renderOverlay?.(pageId)}
            </>
          )}
        </Suspense>
      </PDFErrorBoundary>
    </div>
  );
};

const PDFPageSkeleton = () => (
  <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
);

type PDFPageContentProps = {
  pageId: string;
  renderPromise: Promise<RenderPageResult>;
};

const PDFPageContent = ({ pageId, renderPromise }: PDFPageContentProps) => {
  const isRenderPromiseStale = usePDFStore((s) => s.isRenderPromiseStale);
  const result = use(renderPromise);

  if (Result.isError(result)) {
    if (result.error.code === "CANCELLED") {
      return null;
    }
    throw result.error;
  }

  const rendered = result.value;

  return (
    <>
      <div
        ref={(el) => {
          if (!el) {
            return;
          }

          el.append(rendered.canvas);

          return () => {
            el.innerHTML = "";
            if (isRenderPromiseStale(pageId, renderPromise)) {
              rendered.canvas.width = 0;
              rendered.canvas.height = 0;
            }
          };
        }}
        className="size-full overflow-hidden"
      />
      <div
        ref={(el) => {
          if (!el) {
            return;
          }

          rendered.textLayerDiv.setAttribute(TEXT_LAYER_ATTRIBUTE, pageId);
          el.append(rendered.textLayerDiv);

          return () => {
            el.innerHTML = "";
          };
        }}
        className="[&_br]:absolute [&_br]:z-1 [&_br]:origin-top-left [&_br]:cursor-text [&_br]:whitespace-pre [&_br]:text-transparent [&_br::selection]:bg-transparent [&_span]:absolute [&_span]:z-1 [&_span]:origin-top-left [&_span]:cursor-text [&_span]:whitespace-pre [&_span]:text-transparent [&_span::selection]:bg-indigo-600/25"
      />
    </>
  );
};
