import type { CSSProperties } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { readerPdfPageAnchorId } from "@stll/api-contract/legal-reader-annotations";
import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { ReviewCommentCard } from "@stll/ui/review-comment-card";
import { ScrollArea } from "@stll/ui/scroll-area";

import { saveCommentEdit } from "@/components/legal-reader/annotations/comment-edit";
import { isPendingAnnotationId } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import {
  InlineCommentNote,
  MarginNotes,
} from "@/components/legal-reader/margin-notes";
import type { CommentMarginItem } from "@/components/legal-reader/margin-notes";
import { DETACHED_REASON } from "@/components/pdf/annotations/document-mark-anchor.logic";
import type { DetachedReason } from "@/components/pdf/annotations/document-mark-anchor.logic";
import type {
  DocumentMark,
  DocumentMarks,
  PlacedSpan,
} from "@/components/pdf/annotations/use-document-marks";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

const MARK_TIME_FORMAT = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** The reader's comment cards size their text by the reader's scale; the
 *  viewer's panel shows them at the reader's default. */
const PANEL_TEXT_SCALE: CSSProperties & { "--reader-text-scale": number } = {
  "--reader-text-scale": 1,
};

/** A comment being written on the passage the reader selected. */
export type PendingComment = { quote: string; spans: PlacedSpan[] };

/** One entry per mark: its first row, which carries a comment's words. */
const firstRows = (marks: readonly DocumentMark[]): DocumentMark[] => {
  const seen = new Set<string>();
  const rows: DocumentMark[] = [];
  for (const mark of marks) {
    const key = mark.groupId ?? mark.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(mark);
  }
  return rows;
};

/** Every page a mark covers is detached, or none: the first row stands in. */
const detachedReason = (mark: DocumentMark): DetachedReason | null =>
  mark.placement.type === "detached" ? mark.placement.reason : null;

const commentItem = (
  marks: DocumentMarks,
  mark: DocumentMark,
): CommentMarginItem => ({
  author: { image: mark.authorImage, name: mark.authorName },
  createdAt: mark.createdAt,
  id: mark.id,
  kind: "comment",
  mine: mark.mine,
  onDelete: () => {
    detached(marks.remove(mark.id), "document-annotations.remove");
  },
  onEdit: (edit) => {
    detached(
      saveCommentEdit({
        comment: {
          body: mark.body ?? "",
          id: mark.id,
          visibility: mark.visibility,
        },
        edit,
        // A failed write has already rolled back and told the reader why.
        update: async (change) =>
          (await Result.tryPromise(async () => marks.update(change))).map(
            () => undefined,
          ),
      }),
      "document-annotations.edit",
    );
  },
  onToggleVisibility: () => {
    detached(
      marks.update({
        change: "visibility",
        id: mark.id,
        visibility: mark.visibility === "shared" ? "private" : "shared",
      }),
      "document-annotations.visibility",
    );
  },
  startAnchorId: readerPdfPageAnchorId(mark.pageNumber),
  targetType: "matter-document",
  text: mark.body ?? "",
  updatedAt: mark.updatedAt,
  visibility: mark.visibility,
});

/**
 * The comments on the document, beside its pages, in the reader's own comment
 * cards, and every mark that is not on the pages shown: a mark made on
 * another version whose page now reads differently, or whose words this page
 * no longer holds, keeps its quote and stays here rather than disappearing.
 * Picking a comment's page shows its words there.
 */
export const DocumentMarksPanel = ({
  activeId,
  composing,
  marks,
  onActivate,
  onClose,
  onComposed,
}: {
  activeId: string | null;
  composing: PendingComment | null;
  marks: DocumentMarks;
  onActivate: (mark: DocumentMark) => void;
  onClose: () => void;
  /** The pending comment was saved or dropped. */
  onComposed: () => void;
}) => {
  const t = useTranslations();
  const entries = firstRows(marks.marks);
  const comments = entries.filter(
    (mark) =>
      mark.kind === "comment" &&
      mark.body !== null &&
      detachedReason(mark) === null,
  );
  const detachedMarks = entries.filter((mark) => detachedReason(mark) !== null);

  return (
    <aside
      aria-label={t("folio.comments.visibility")}
      className="bg-background flex h-full w-72 shrink-0 flex-col border-s"
      style={PANEL_TEXT_SCALE}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">
          {t("folio.comments.visibility")}
        </h2>
        <Button
          aria-label={t("common.close")}
          onClick={onClose}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {composing === null ? null : (
          <div className="border-b px-3 py-2">
            <p className="text-muted-foreground text-2xs mb-1 line-clamp-2 italic">
              {composing.quote}
            </p>
            <MarginNotes
              items={[
                {
                  id: "document-comment-composer",
                  kind: "composer",
                  onCancel: onComposed,
                  onSubmit: (body, visibility) => {
                    detached(
                      marks.create({
                        body,
                        kind: "comment",
                        spans: composing.spans,
                        visibility,
                      }),
                      "document-annotations.comment",
                    );
                    onComposed();
                  },
                  startAnchorId: readerPdfPageAnchorId(
                    composing.spans.at(0)?.pageNumber ??
                      panic("A pending comment has no span"),
                  ),
                  targetType: "matter-document",
                },
              ]}
              placement="inline"
            />
          </div>
        )}
        {comments.length === 0 && composing === null ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            {t("workspaces.pdf.annotations.empty")}
          </p>
        ) : (
          <ul className="divide-y">
            {comments.map((mark) => (
              <li
                className="px-3 py-1.5"
                data-active={mark.id === activeId ? "true" : undefined}
                key={mark.id}
              >
                <Button
                  aria-pressed={mark.id === activeId}
                  onClick={() => onActivate(mark)}
                  size="xs"
                  variant="ghost"
                >
                  {t("workspaces.pdf.selection.pageLocator", {
                    page: String(mark.pageNumber),
                  })}
                </Button>
                <InlineCommentNote item={commentItem(marks, mark)} />
              </li>
            ))}
          </ul>
        )}
        {detachedMarks.length === 0 ? null : (
          <section className="border-t">
            <h3 className="text-muted-foreground px-3 pt-2 text-xs font-medium">
              {t("workspaces.pdf.annotations.detachedHeading")}
            </h3>
            <ul className="divide-y">
              {detachedMarks.map((mark) => (
                <DetachedMark key={mark.id} mark={mark} marks={marks} />
              ))}
            </ul>
          </section>
        )}
      </ScrollArea>
    </aside>
  );
};

const detachedLabelKey = (reason: DetachedReason) => {
  switch (reason) {
    case DETACHED_REASON.otherVersion: {
      return "workspaces.pdf.annotations.detachedOtherVersion" as const;
    }
    case DETACHED_REASON.textChanged: {
      return "workspaces.pdf.annotations.detachedTextChanged" as const;
    }
    default: {
      reason satisfies never;
      return panic(`Unhandled detached reason: ${String(reason)}`);
    }
  }
};

/** A mark with no place on the pages shown: its quote, and why. */
const DetachedMark = ({
  mark,
  marks,
}: {
  mark: DocumentMark;
  marks: DocumentMarks;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const createdAt = new Date(mark.createdAt);
  const reason =
    detachedReason(mark) ?? panic("A listed detached mark has no reason");
  const removable = mark.mine && !isPendingAnnotationId(mark.id);
  return (
    <li>
      <ReviewCommentCard
        anchorText={mark.quote}
        author={{ image: mark.authorImage, name: mark.authorName }}
        body={mark.body ?? t("legalReader.annotations.highlightedPassage")}
        canDelete={removable}
        deleteLabel={
          mark.kind === "highlight"
            ? t("legalReader.annotations.removeHighlight")
            : t("common.delete")
        }
        formattedTime={format.dateTime(createdAt, MARK_TIME_FORMAT)}
        isStale
        onDelete={() => {
          detached(marks.remove(mark.id), "document-annotations.remove");
        }}
        staleLabel={t(detachedLabelKey(reason), {
          page: String(mark.pageNumber),
          version: String(mark.versionNumber),
        })}
        timestamp={createdAt}
      />
    </li>
  );
};
