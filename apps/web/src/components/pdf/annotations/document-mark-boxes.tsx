import { BidiText } from "@stll/ui/bidi-text";
import { textMarkBoxClass } from "@stll/ui/text-mark";
import type { TextMarkOptions } from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

import {
  MARK_COLOR_TONE,
  MARK_STYLE_VARIANT,
} from "@/components/pdf/annotations/document-mark-anchor.logic";
import type { DocumentMark } from "@/components/pdf/annotations/use-document-marks";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";

/** Names the mark a drawn box belongs to, for hit testing a press. */
export const DOCUMENT_MARK_BOX_ATTRIBUTE = "data-document-mark-id";

/** What the page layers draw: the marks placed on this file, by id. */
export type DocumentMarksSurface = {
  activeId: string | null;
  hoveredId: string | null;
  marks: readonly DocumentMark[];
  /** The viewer's page number for a page id, as the selection reads it. */
  pageNumberOf: (pageId: string) => number | null;
};

/** A comment is a passage with words beside it: a dotted line under it. */
const COMMENT_MARK = {
  variant: "dotted",
  tone: "option-sky",
} as const satisfies Omit<TextMarkOptions, "weight">;

const markLook = (
  mark: DocumentMark,
): Omit<TextMarkOptions, "weight" | "state"> => {
  if (mark.kind === "highlight" && mark.color !== null && mark.style !== null) {
    return {
      variant: MARK_STYLE_VARIANT[mark.style],
      tone: MARK_COLOR_TONE[mark.color],
    };
  }
  return COMMENT_MARK;
};

/** The ids every row of one mark shares: the group, or the row alone. */
const markKey = (mark: Pick<DocumentMark, "groupId" | "id">) =>
  mark.groupId ?? mark.id;

type DocumentMarkBoxesProps = Omit<DocumentMarksSurface, "pageNumberOf"> & {
  pageNumber: number;
  /** Converts PDF units to the page's rendered pixels. */
  viewport: Parameters<typeof toPDFSearchViewportBox>[1];
};

/** The boxes of the marks placed on one page, at the page's current scale. */
export const DocumentMarkBoxes = ({
  activeId,
  hoveredId,
  marks,
  pageNumber,
  viewport,
}: DocumentMarkBoxesProps) => {
  const onPage = marks.filter(
    (mark) =>
      mark.pageNumber === pageNumber && mark.placement.type === "placed",
  );
  if (onPage.length === 0) {
    return null;
  }
  const activeMark = marks.find((mark) => mark.id === activeId) ?? null;
  const hovered = marks.find((mark) => mark.id === hoveredId) ?? null;
  return (
    <div
      aria-hidden={true}
      className="pointer-events-none absolute inset-0 z-2"
      data-document-mark-layer={true}
    >
      {onPage.flatMap((mark) => {
        if (mark.placement.type !== "placed") {
          return [];
        }
        const active =
          activeMark !== null && markKey(activeMark) === markKey(mark);
        const look = markLook(mark);
        const boxes = mark.placement.boxes.flatMap((box) => {
          const style = toPDFSearchViewportBox(box, viewport);
          return style === null || style.width <= 0 || style.height <= 0
            ? []
            : [style];
        });
        const comment =
          hovered?.id === mark.id && mark.body !== null ? mark.body : null;
        const first = boxes.at(0);
        return [
          ...boxes.map((style, index) => (
            <div
              className={cn(
                "absolute",
                textMarkBoxClass({
                  ...look,
                  state: active ? "active" : "rest",
                }),
              )}
              data-active={active ? "true" : undefined}
              key={`${mark.id}:${String(index)}`}
              style={style}
              {...{ [DOCUMENT_MARK_BOX_ATTRIBUTE]: mark.id }}
            />
          )),
          comment !== null && first !== undefined ? (
            <div
              className="bg-popover text-popover-foreground absolute z-10 max-w-64 rounded-md border px-2 py-1.5 text-xs shadow-md"
              key={`${mark.id}:comment`}
              style={{ left: first.left, top: first.top + first.height + 4 }}
            >
              <BidiText
                as="p"
                className="text-muted-foreground mb-0.5 truncate"
              >
                {mark.authorName}
              </BidiText>
              <BidiText as="p" className="line-clamp-3 whitespace-pre-wrap">
                {comment}
              </BidiText>
            </div>
          ) : null,
        ];
      })}
    </div>
  );
};
