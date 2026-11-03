import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AddCommentIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { SELECTION_REFUSAL } from "@/components/pdf/annotations/document-mark-anchor.logic";
import type { SelectionRefusal } from "@/components/pdf/annotations/document-mark-anchor.logic";
import { DocumentMarkBar } from "@/components/pdf/annotations/document-mark-bar";
import { DOCUMENT_MARK_BOX_ATTRIBUTE } from "@/components/pdf/annotations/document-mark-boxes";
import { DocumentMarksContext } from "@/components/pdf/annotations/document-marks-layer";
import { DocumentMarksPanel } from "@/components/pdf/annotations/document-marks-panel";
import type { PendingComment } from "@/components/pdf/annotations/document-marks-panel";
import { useDocumentMarks } from "@/components/pdf/annotations/use-document-marks";
import type {
  DocumentMark,
  DocumentMarks,
} from "@/components/pdf/annotations/use-document-marks";
import { PdfSelectionToolbar } from "@/components/pdf/pdf-selection-toolbar";
import type {
  PdfSelectionChat,
  PdfSelectionMarking,
} from "@/components/pdf/pdf-selection-toolbar";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { useMatterNumberingEnabled } from "@/lib/organization/use-matter-numbering";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { queryView } from "@/lib/query-view.logic";
import { workspaceOptions } from "@/lib/workspaces/queries";

type PdfSelectionActionsProps = {
  chat: PdfSelectionChat;
  children: ReactNode;
  /** The document the file belongs to; empty where none is known, and the
   *  viewer then offers no marks. */
  entityId: string;
  /** The displayed PDF, whose page texts the marks are placed on. */
  file: { buffer: ArrayBuffer; fileId: string };
  fileFieldId: string;
  fileName: string;
  workspaceId: string;
};

const refusalKey = (reason: SelectionRefusal) => {
  switch (reason) {
    case SELECTION_REFUSAL.noText: {
      return "workspaces.pdf.annotations.refusedNoText" as const;
    }
    case SELECTION_REFUSAL.notFound: {
      return "workspaces.pdf.annotations.refusedNotFound" as const;
    }
    case SELECTION_REFUSAL.tooLong: {
      return "workspaces.pdf.annotations.refusedTooLong" as const;
    }
    default: {
      reason satisfies never;
      return panic(`Unhandled selection refusal: ${String(reason)}`);
    }
  }
};

/** The smallest drawn mark under a point, which the reader most likely meant. */
const markAt = (root: HTMLElement, x: number, y: number): string | null => {
  let best: { area: number; id: string } | null = null;
  for (const box of root.querySelectorAll<HTMLElement>(
    `[${DOCUMENT_MARK_BOX_ATTRIBUTE}]`,
  )) {
    const id = box.getAttribute(DOCUMENT_MARK_BOX_ATTRIBUTE);
    const rect = box.getBoundingClientRect();
    if (
      id === null ||
      x < rect.left ||
      x > rect.right ||
      y < rect.top ||
      y > rect.bottom
    ) {
      continue;
    }
    const area = rect.width * rect.height;
    if (best === null || area < best.area) {
      best = { area, id };
    }
  }
  return best?.id ?? null;
};

/**
 * Wraps a matter PDF viewer so selected words get the selection bar, and the
 * document's highlights and comments are drawn on its pages and listed
 * beside them. The citation names the matter's reference only where the
 * organization shows matter numbers, and numbers pages as the viewer's page
 * indicator does.
 */
export const PdfSelectionActions = ({
  chat,
  children,
  entityId,
  file,
  fileFieldId,
  fileName,
  workspaceId,
}: PdfSelectionActionsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const markBarRef = useRef<HTMLDivElement | null>(null);
  const showMatterNumber = useMatterNumberingEnabled();
  const workspaceView = queryView(useQuery(workspaceOptions(workspaceId)));
  const reference =
    showMatterNumber && workspaceView.type === "items"
      ? workspaceView.items.reference
      : null;
  const pages = usePDFStore((state) => state.pages);
  const setScrollTo = usePDFStore((state) => state.setScrollTo);
  const pageSource = usePDFStore((state) => state.document?.pageSource);
  const pageIds = pages.keys().toArray();
  const pageNumberOf = (pageId: string): number | null => {
    const index = pageIds.indexOf(pageId);
    return index === -1 ? null : index + 1;
  };

  const marks = useDocumentMarks({
    entityId,
    fieldId: fileFieldId,
    file,
    pageSource,
    workspaceId,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [composing, setComposing] = useState<PendingComment | null>(null);
  const activeMark = marks.marks.find((mark) => mark.id === activeId) ?? null;

  const markTo = useLatestCallback(
    async (
      layers: Parameters<DocumentMarks["locate"]>[0],
    ): Promise<Awaited<ReturnType<DocumentMarks["locate"]>> | null> => {
      const located = await marks.locate(layers);
      if (located.type === "refused") {
        stellaToast.warning(t(refusalKey(located.reason)));
        return null;
      }
      return located;
    },
  );

  const marking: PdfSelectionMarking | undefined = marks.available
    ? {
        onHighlight: (passage, { color, style }) => {
          detached(
            (async () => {
              const located = await markTo(passage.layers);
              if (located?.type === "located") {
                await marks.create({
                  color,
                  kind: "highlight",
                  spans: located.spans,
                  style,
                  visibility: "private",
                });
              }
            })(),
            "document-annotations.highlight",
          );
        },
        onComment: (passage) => {
          detached(
            (async () => {
              const located = await markTo(passage.layers);
              if (located?.type === "located") {
                setComposing({ quote: passage.quote, spans: located.spans });
                setPanelOpen(true);
              }
            })(),
            "document-annotations.compose",
          );
        },
      }
    : undefined;

  const showOnPage = (mark: DocumentMark) => {
    setActiveId(mark.id);
    const pageId = pageIds.at(mark.pageNumber - 1);
    if (pageId !== undefined) {
      setScrollTo({ pageId });
    }
  };

  // Marks are drawn under the text layer and take no press, so a press is
  // hit tested against their boxes: the text keeps every selection, and a
  // plain press on a mark picks it.
  const isOnChrome = useLatestCallback(
    (node: Node) =>
      barRef.current?.contains(node) === true ||
      markBarRef.current?.contains(node) === true,
  );
  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    let frame = 0;
    const onPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Node && isOnChrome(event.target)) {
        return;
      }
      const selection = ownerDoc.getSelection();
      if (
        event.button !== 0 ||
        (selection !== null && !selection.isCollapsed) ||
        !(event.target instanceof Node) ||
        !root.contains(event.target)
      ) {
        return;
      }
      setActiveId(markAt(root, event.clientX, event.clientY));
    };
    const onPointerMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hovered = markAt(root, event.clientX, event.clientY);
        setHoveredId((current) => (current === hovered ? current : hovered));
      });
    };
    const onPointerLeave = () => {
      cancelAnimationFrame(frame);
      setHoveredId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveId(null);
      }
    };
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    ownerDoc.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      ownerDoc.removeEventListener("keydown", onKeyDown);
    };
  });

  const commentCount = new Set(
    marks.marks
      .filter((mark) => mark.kind === "comment")
      .map((mark) => mark.groupId ?? mark.id),
  ).size;

  return (
    <DocumentMarksContext
      value={{ activeId, hoveredId, marks: marks.marks, pageNumberOf }}
    >
      <div className="flex h-full min-w-0">
        <div className="relative h-full min-w-0 flex-1" ref={rootRef}>
          {children}
          {marks.available && !panelOpen ? (
            <div className="absolute end-3 top-2 z-10">
              <Button
                aria-expanded={false}
                onClick={() => setPanelOpen(true)}
                size="sm"
                variant="outline"
              >
                <AddCommentIcon className="size-3.5" />
                {t("folio.comments.visibility")}
                {commentCount === 0 ? null : (
                  <span className="text-muted-foreground tabular-nums">
                    {format.number(commentCount)}
                  </span>
                )}
              </Button>
            </div>
          ) : null}
        </div>
        {marks.available && panelOpen ? (
          <DocumentMarksPanel
            activeId={activeId}
            composing={composing}
            marks={marks}
            onActivate={showOnPage}
            onClose={() => {
              setPanelOpen(false);
              setComposing(null);
            }}
            onComposed={() => setComposing(null)}
          />
        ) : null}
      </div>
      <PdfSelectionToolbar
        chat={chat}
        citedDocument={{ fileFieldId, name: fileName, reference }}
        marking={marking}
        onAttach={(node) => {
          barRef.current = node;
        }}
        pageNumberOf={pageNumberOf}
        rootRef={rootRef}
      />
      {activeMark === null ? null : (
        <DocumentMarkBar
          key={activeMark.id}
          mark={activeMark}
          marks={marks}
          onAttach={(node) => {
            markBarRef.current = node;
          }}
          onClose={() => setActiveId(null)}
          onOpenComments={() => setPanelOpen(true)}
          rootRef={rootRef}
        />
      )}
    </DocumentMarksContext>
  );
};
