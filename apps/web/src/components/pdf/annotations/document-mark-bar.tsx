import { useSyncExternalStore } from "react";
import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { useExternalSyncEffect, useKeyedState } from "@stll/ui/effects";
import { AddCommentIcon, Trash2Icon } from "@stll/ui/icons";

import { isPendingAnnotationId } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import { DOCUMENT_MARK_BOX_ATTRIBUTE } from "@/components/pdf/annotations/document-mark-boxes";
import type {
  DocumentMark,
  DocumentMarks,
} from "@/components/pdf/annotations/use-document-marks";
import { SelectionToolbar } from "@/components/selection-toolbar";
import {
  MarkColorSwatches,
  MarkStyleButtons,
  MarkVisibilityToggle,
} from "@/components/selection-toolbar-marks";
import { selectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import type { SelectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import Tooltip from "@/components/tooltip";
import { detached } from "@/lib/detached";

/**
 * The first drawn box of the mark, where the bar floats, clipped to the
 * reader's visible scroll area as a selection's bar is.
 */
const markGeometry = (
  root: HTMLElement,
  id: string,
): SelectionToolbarAnchor | null => {
  const box = root.querySelector(
    `[${DOCUMENT_MARK_BOX_ATTRIBUTE}="${CSS.escape(id)}"]`,
  );
  if (box === null) {
    return null;
  }
  const range = root.ownerDocument.createRange();
  range.selectNode(box);
  return selectionToolbarAnchor({ range, root });
};

// The container's document, read from the container itself once it has
// mounted: `null` on the server and in the first render, then the document
// (the store's mount check re-reads it after the commit that attaches it).
// It never changes for a mounted container, so there is nothing to subscribe to.
const noDocumentChanges = () => () => undefined;
const noDocument = () => null;

/**
 * The bar over a mark the reader pressed: the author changes a highlight's
 * style, colour or audience, opens its comments, or removes it; anyone else
 * sees whose mark it is. It follows the mark while the pages scroll.
 */
export const DocumentMarkBar = ({
  mark,
  marks,
  onAttach,
  onClose,
  onOpenComments,
  rootRef,
}: {
  mark: DocumentMark;
  marks: DocumentMarks;
  onAttach: (node: HTMLDivElement | null) => void;
  onClose: () => void;
  onOpenComments: () => void;
  rootRef: RefObject<HTMLElement | null>;
}) => {
  const t = useTranslations();
  // The geometry belongs to one mark and starts over when the mark changes.
  const [geometry, setGeometry] = useKeyedState<SelectionToolbarAnchor | null>(
    mark.id,
    null,
  );
  const doc = useSyncExternalStore(
    noDocumentChanges,
    () => rootRef.current?.ownerDocument ?? null,
    noDocument,
  );

  useExternalSyncEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    const update = () => setGeometry(markGeometry(root, mark.id));
    // The first measurement waits for the frame, like every later one.
    const firstFrame = requestAnimationFrame(update);
    ownerDoc.addEventListener("scroll", update, true);
    ownerDoc.defaultView?.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => {
      cancelAnimationFrame(firstFrame);
      observer.disconnect();
      ownerDoc.removeEventListener("scroll", update, true);
      ownerDoc.defaultView?.removeEventListener("resize", update);
    };
  }, [mark.id, rootRef, setGeometry]);

  if (geometry === null) {
    return null;
  }
  const editable = mark.mine && !isPendingAnnotationId(mark.id);
  const removeLabel =
    mark.kind === "highlight"
      ? t("legalReader.annotations.removeHighlight")
      : t("common.delete");

  return (
    <SelectionToolbar
      anchorRect={geometry.rect}
      boundaryRect={geometry.bounds}
      doc={doc}
      onAttach={onAttach}
    >
      <div className="flex flex-wrap items-center gap-1">
        {editable && mark.kind === "highlight" ? (
          <>
            <MarkStyleButtons
              current={mark.style ?? "highlight"}
              onPick={(style) => {
                detached(
                  marks.update({ change: "style", id: mark.id, style }),
                  "document-annotations.restyle",
                );
              }}
            />
            <span className="bg-border mx-1 h-4 w-px" />
            <div className="flex items-center gap-1.5 px-1">
              <MarkColorSwatches
                onPick={(color) => {
                  detached(
                    marks.update({ change: "color", color, id: mark.id }),
                    "document-annotations.recolor",
                  );
                }}
              />
            </div>
            <span className="bg-border mx-1 h-4 w-px" />
          </>
        ) : null}
        {editable ? null : (
          <span className="text-muted-foreground px-1.5 text-xs">
            {mark.kind === "highlight"
              ? t("workspaces.pdf.annotations.highlightedBy", {
                  name: mark.authorName,
                })
              : t("workspaces.pdf.annotations.commentedBy", {
                  name: mark.authorName,
                })}
          </span>
        )}
        {mark.kind === "comment" ? (
          <Button onClick={onOpenComments} size="sm" variant="ghost">
            <AddCommentIcon className="size-3.5" />
            {t("folio.comments.visibility")}
          </Button>
        ) : null}
        {editable ? (
          <>
            <MarkVisibilityToggle
              onChange={(visibility) => {
                detached(
                  marks.update({
                    change: "visibility",
                    id: mark.id,
                    visibility,
                  }),
                  "document-annotations.visibility",
                );
              }}
              sharedLabel={t(
                "legalReader.annotations.visibilitySharedWithMatter",
              )}
              value={mark.visibility}
            />
            <Tooltip
              content={removeLabel}
              render={
                <Button
                  aria-label={removeLabel}
                  onClick={() => {
                    detached(
                      marks.remove(mark.id),
                      "document-annotations.remove",
                    );
                    onClose();
                  }}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <Trash2Icon className="size-3.5" />
            </Tooltip>
          </>
        ) : null}
      </div>
    </SelectionToolbar>
  );
};
