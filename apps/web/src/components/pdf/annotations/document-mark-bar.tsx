import { useState } from "react";
import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";

type Geometry = { bounds: DOMRect; rect: DOMRect };

/** The first drawn box of the mark, where the bar floats. */
const markGeometry = (root: HTMLElement, id: string): Geometry | null => {
  const box = root.querySelector(
    `[${DOCUMENT_MARK_BOX_ATTRIBUTE}="${CSS.escape(id)}"]`,
  );
  return box === null
    ? null
    : {
        bounds: root.getBoundingClientRect(),
        rect: box.getBoundingClientRect(),
      };
};

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
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);

  useExternalSyncEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    const update = () => setGeometry(markGeometry(root, mark.id));
    update();
    ownerDoc.addEventListener("scroll", update, true);
    ownerDoc.defaultView?.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => {
      observer.disconnect();
      ownerDoc.removeEventListener("scroll", update, true);
      ownerDoc.defaultView?.removeEventListener("resize", update);
    };
  }, [mark.id, rootRef]);

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
              sharedLabel={t("workspaces.pdf.annotations.visibilityShared")}
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
