import type { ReactNode } from "react";

import { CheckIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

import { BidiText } from "../components/bidi-text";
import { Button } from "../components/button";
import { cn } from "../lib/utils";
import { ReviewAuthorAvatar } from "./review-author-avatar";

export type ReviewCommentAuthor = {
  name: string | null;
  image?: string | null | undefined;
  deleted?: boolean | undefined;
};

type ReviewCommentCardProps = {
  author: ReviewCommentAuthor;
  /** Machine-readable instant for `<time>`; ISO string or Date. */
  timestamp: string | Date;
  /** The same instant, already formatted by the host's locale formatter. */
  formattedTime: string;
  body: ReactNode;
  /** The text the comment was written against, when it is worth echoing. */
  anchorText?: string | undefined;
  /** The comment is anchored to text the document has since moved past. */
  isStale?: boolean | undefined;
  staleLabel?: string | undefined;
  resolved?: boolean | undefined;
  onToggleResolved?: (() => void) | undefined;
  resolveLabel?: string | undefined;
  reopenLabel?: string | undefined;
  canDelete?: boolean | undefined;
  onDelete?: (() => void) | undefined;
  deleteLabel?: string | undefined;
  className?: string;
};

/** One comment on a reviewed surface: who wrote it, when, what it says, what
 *  it points at, and the two things a reader can do to it. */
export const ReviewCommentCard = ({
  author,
  timestamp,
  formattedTime,
  body,
  anchorText,
  isStale = false,
  staleLabel,
  resolved = false,
  onToggleResolved,
  resolveLabel,
  reopenLabel,
  canDelete = false,
  onDelete,
  deleteLabel,
  className,
}: ReviewCommentCardProps) => (
  <article
    className={cn(
      "flex items-start gap-2 px-3 py-2",
      resolved && "opacity-60",
      className,
    )}
    data-slot="review-comment-card"
  >
    <ReviewAuthorAvatar
      className="mt-0.5 size-5 shrink-0 text-[9px]"
      deleted={author.deleted}
      image={author.image}
      name={author.name}
    />
    <div className="min-w-0 flex-1">
      <p className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-[11px]">
        <BidiText
          as="span"
          className="text-foreground-strong-muted truncate font-medium"
        >
          {author.name}
        </BidiText>
        <time
          className="shrink-0 tabular-nums"
          dateTime={toIsoInstant(timestamp)}
        >
          {formattedTime}
        </time>
      </p>
      <BidiText as="div" className="text-foreground text-xs wrap-anywhere">
        {body}
      </BidiText>
      {anchorText === undefined || anchorText === "" ? null : (
        <BidiText
          as="p"
          className="text-muted-foreground mt-0.5 truncate text-[11px] italic"
        >
          {anchorText}
        </BidiText>
      )}
      {isStale && staleLabel !== undefined ? (
        <p className="text-muted-foreground mt-0.5 text-[11px]">{staleLabel}</p>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-0.5">
      {onToggleResolved === undefined ? null : (
        <Button
          aria-label={resolved ? reopenLabel : resolveLabel}
          onClick={onToggleResolved}
          size="icon-xs"
          variant="ghost"
        >
          {resolved ? <RotateCcwIcon /> : <CheckIcon />}
        </Button>
      )}
      {canDelete && onDelete !== undefined ? (
        <Button
          aria-label={deleteLabel}
          onClick={onDelete}
          size="icon-xs"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </div>
  </article>
);

/** `<time dateTime>` wants a machine-readable instant. An unparseable date
 *  yields no attribute rather than throwing on `toISOString`. */
const toIsoInstant = (timestamp: string | Date): string | undefined => {
  if (typeof timestamp === "string") {
    return timestamp;
  }
  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
};
