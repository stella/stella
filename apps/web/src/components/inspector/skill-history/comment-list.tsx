import { CheckIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";

import type { MemberNameLookup, SkillCommentRow } from "./skill-history.logic";

type CommentListProps = {
  comments: readonly SkillCommentRow[];
  /** Comments anchored elsewhere are shown but not highlighted in the text. */
  currentRevisionId: string | null;
  canManage: boolean;
  userId: string;
  authorName: MemberNameLookup;
  onToggleResolved: (comment: SkillCommentRow) => void;
  onDelete: (commentId: string) => void;
};

/**
 * Every comment on the skill body, including the ones written against a
 * revision the text has since moved past. Those stay readable but are not
 * projected into the editor: their offsets no longer describe the current text
 * and there is no re-anchoring yet.
 */
export const CommentList = ({
  comments,
  currentRevisionId,
  canManage,
  userId,
  authorName,
  onToggleResolved,
  onDelete,
}: CommentListProps) => {
  const t = useTranslations();

  if (comments.length === 0) {
    return (
      <p className="text-muted-foreground border-b px-3 py-2 text-xs">
        {t("skillHistory.commentsEmpty")}
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-48 border-b">
      <ul className="divide-y">
        {comments.map((comment) => (
          <CommentRow
            authorName={authorName}
            canDelete={canManage || comment.authorId === userId}
            comment={comment}
            isStale={comment.revisionId !== currentRevisionId}
            key={comment.id}
            onDelete={onDelete}
            onToggleResolved={onToggleResolved}
          />
        ))}
      </ul>
    </ScrollArea>
  );
};

type CommentRowProps = {
  comment: SkillCommentRow;
  isStale: boolean;
  canDelete: boolean;
  authorName: MemberNameLookup;
  onToggleResolved: (comment: SkillCommentRow) => void;
  onDelete: (commentId: string) => void;
};

const CommentRow = ({
  comment,
  isStale,
  canDelete,
  authorName,
  onToggleResolved,
  onDelete,
}: CommentRowProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const isResolved = comment.resolvedAt !== null;

  return (
    <li className={cn("px-3 py-2", isResolved && "opacity-60")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground truncate text-[11px]">
            {t("skillHistory.commentMeta", {
              author: authorName(comment.authorId),
              date: format.dateTime(new Date(comment.createdAt), {
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                month: "short",
              }),
            })}
          </p>
          <p className="text-foreground text-xs wrap-anywhere">
            {comment.body}
          </p>
          {comment.anchorText === "" ? null : (
            <p className="text-muted-foreground mt-0.5 truncate text-[11px] italic">
              {comment.anchorText}
            </p>
          )}
          {isStale ? (
            <p className="text-muted-foreground mt-0.5 text-[11px]">
              {t("skillHistory.commentFromEarlierRevision")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            aria-label={
              isResolved
                ? t("inspector.review.reopen")
                : t("skillHistory.resolveComment")
            }
            onClick={() => {
              onToggleResolved(comment);
            }}
            size="icon-xs"
            variant="ghost"
          >
            {isResolved ? (
              <RotateCcwIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
          </Button>
          {canDelete ? (
            <Button
              aria-label={t("common.delete")}
              onClick={() => {
                onDelete(comment.id);
              }}
              size="icon-xs"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
};
