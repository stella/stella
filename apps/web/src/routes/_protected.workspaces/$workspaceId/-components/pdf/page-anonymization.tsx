import type { MouseEvent } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { getEntityColor } from "@/lib/anonymize/ui-constants";
import { useOverlayRects } from "@/lib/anonymize/use-overlay-rects";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type PageAnonymizationProps = {
  pageId: string;
  pageIndex: number;
  variant: "peek" | "fullscreen";
  /** Peek only: run after user chooses to open fullscreen (e.g. close inspector). */
  onPeekNavigate?: (() => void) | undefined;
  peekNavigation?: {
    workspaceId: string;
    viewId: string;
    fieldId: string;
    entityId: string;
    activePropertyId: string;
  };
};

export const PageAnonymization = ({
  pageId,
  pageIndex,
  variant,
  onPeekNavigate,
  peekNavigation,
}: PageAnonymizationProps) => {
  const overlays = usePDFStore(
    useShallow((s) => s.fileAnonymization?.perPage.get(pageIndex)),
  );

  const entityRects = useOverlayRects(pageId, pageIndex);

  const [scrollTo, setScrollTo] = usePDFStore(
    useShallow((s) => [s.scrollTo, s.setScrollTo]),
  );

  const navigate = useNavigate();
  const setPdfViewerState = useWorkspaceStore((s) => s.setPdfViewerState);

  if (!overlays || !entityRects || entityRects.size === 0) {
    return null;
  }

  return (
    <div
      aria-hidden={true}
      className={
        variant === "peek" && peekNavigation
          ? "absolute inset-0 z-10"
          : "pointer-events-none absolute inset-0"
      }
    >
      {overlays.flatMap((entity) => {
        const rects = entityRects.get(entity.id);
        if (!rects) {
          return [];
        }

        const topRectIndex = rects
          .map((r, i) => ({ r, i }))
          .toSorted((a, b) => a.r.top - b.r.top)
          .at(0)?.i;

        return rects.map((rect, i) => {
          const isScrollTarget =
            variant === "fullscreen" &&
            scrollTo?.target?.kind === "anonymizeEntity" &&
            scrollTo.target.entityId === entity.id &&
            scrollTo.pageId === pageId;

          const handlePeekClick =
            variant === "peek" && peekNavigation
              ? async (e: MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onPeekNavigate?.();
                  const pageNumber = pageIndex + 1;
                  const previousPdfViewer = {
                    ...useWorkspaceStore.getState().pdfViewer,
                  };
                  try {
                    setPdfViewerState({
                      activePropertyId: peekNavigation.activePropertyId,
                      pendingAnonymizeEntityId: entity.id,
                      scaleOffset: 0,
                      sidebar: "anonymize",
                    });
                    await navigate({
                      to: "/workspaces/$workspaceId/$viewId/document",
                      params: {
                        workspaceId: peekNavigation.workspaceId,
                        viewId: peekNavigation.viewId,
                      },
                      search: {
                        entity: peekNavigation.entityId,
                        field: peekNavigation.fieldId,
                        justification: undefined,
                        justificationPage: undefined,
                        pdfPage: pageNumber,
                      },
                    });
                  } catch (error) {
                    setPdfViewerState(previousPdfViewer);
                    throw error;
                  }
                }
              : undefined;

          const interactive =
            variant === "peek" && peekNavigation !== undefined;

          const commonStyle = {
            backgroundColor: getEntityColor(entity.label),
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          } as const;

          if (interactive) {
            return (
              <button
                className="absolute rounded-xs opacity-50 hover:opacity-70"
                key={`${entity.id}-${i}`}
                onClick={handlePeekClick}
                style={commonStyle}
                type="button"
              />
            );
          }

          return (
            <div
              className="absolute rounded-xs opacity-50"
              key={`${entity.id}-${i}`}
              ref={(el) => {
                if (isScrollTarget && i === topRectIndex && el !== null) {
                  el.scrollIntoView({
                    block: "center",
                    inline: "center",
                  });
                  setScrollTo(null);
                }
              }}
              style={commonStyle}
            />
          );
        });
      })}
    </div>
  );
};
