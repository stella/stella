import { useTranslations } from "use-intl";

import { ReviewCommentCard } from "@stll/ui/review-comment-card";
import { ScrollArea } from "@stll/ui/scroll-area";

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
  const createdAt = new Date(comment.createdAt);

  return (
    <li>
      <ReviewCommentCard
        anchorText={comment.anchorText}
        author={{ name: authorName(comment.authorId) }}
        body={comment.body}
        canDelete={canDelete}
        deleteLabel={t("common.delete")}
        formattedTime={format.dateTime(createdAt, COMMENT_TIME_FORMAT)}
        isStale={isStale}
        onDelete={() => {
          onDelete(comment.id);
        }}
        onToggleResolved={() => {
          onToggleResolved(comment);
        }}
        reopenLabel={t("inspector.review.reopen")}
        resolveLabel={t("skillHistory.resolveComment")}
        resolved={comment.resolvedAt !== null}
        staleLabel={t("skillHistory.commentFromEarlierRevision")}
        timestamp={createdAt}
      />
    </li>
  );
};

const COMMENT_TIME_FORMAT = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
} as const satisfies Intl.DateTimeFormatOptions;
