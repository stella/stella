/**
 * Reviewers' comments on one verification claim, in the claim detail panel.
 * The case-law reader's comment notes and composer, drawn inline: the same
 * cards, the same author-only controls, the same private-until-shared rule.
 */

import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AddCommentIcon } from "@stll/ui/icons";

import { saveCommentEdit } from "@/components/legal-reader/annotations/comment-edit";
import type {
  CommentMarginItem,
  ComposerMarginItem,
} from "@/components/legal-reader/margin-notes";
import { MarginNotes } from "@/components/legal-reader/margin-notes";
import type { VerificationClaim } from "@/features/avt/types";
import { useClaimComments } from "@/features/avt/use-claim-comments";
import { detached } from "@/lib/detached";

type ClaimCommentsProps = {
  claim: VerificationClaim;
  runId: string;
  workspaceId: string;
};

export const ClaimComments = ({
  claim,
  runId,
  workspaceId,
}: ClaimCommentsProps) => {
  const t = useTranslations();
  const { available, comments, create, remove, update } = useClaimComments({
    claim,
    runId,
    workspaceId,
  });
  const [composing, setComposing] = useState(false);

  if (!available) {
    return null;
  }

  const anchorId = claim.id;
  const commentItems: CommentMarginItem[] = comments.map((comment) => ({
    author: { image: comment.authorImage, name: comment.authorName },
    createdAt: comment.createdAt,
    id: comment.id,
    kind: "comment",
    mine: comment.mine,
    onDelete: () => {
      detached(remove(comment.id), "avt.claim-comment-remove");
    },
    onEdit: (edit) => {
      detached(
        saveCommentEdit({
          comment: {
            body: comment.body ?? "",
            id: comment.id,
            visibility: comment.visibility,
          },
          edit,
          // A failed write has already rolled back and told the reviewer why.
          update: async (change) =>
            (await Result.tryPromise(async () => update(change))).map(
              () => undefined,
            ),
        }),
        "avt.claim-comment-edit",
      );
    },
    onToggleVisibility: () => {
      detached(
        update({
          change: "visibility",
          id: comment.id,
          visibility: comment.visibility === "shared" ? "private" : "shared",
        }),
        "avt.claim-comment-visibility",
      );
    },
    startAnchorId: anchorId,
    targetType: "verification-claim",
    text: comment.body ?? "",
    updatedAt: comment.updatedAt,
    visibility: comment.visibility,
  }));
  const composerItems: ComposerMarginItem[] = composing
    ? [
        {
          id: "composer",
          kind: "composer",
          onCancel: () => setComposing(false),
          onSubmit: (body, visibility) => {
            detached(create(body, visibility), "avt.claim-comment-create");
            setComposing(false);
          },
          startAnchorId: anchorId,
          targetType: "verification-claim",
        },
      ]
    : [];
  const items = [...commentItems, ...composerItems];

  return (
    <section className="space-y-2.5 border-t pt-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
          {t("folio.comments.visibility")}
        </h3>
        {!composing && (
          <Button onClick={() => setComposing(true)} size="sm" variant="ghost">
            <AddCommentIcon />
            {t("folio.comment")}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("folio.comments.noComments")}
        </p>
      ) : (
        // The notes size their text off the reader's scale; outside a reader
        // they take the panel's own size.
        <div className="text-xs">
          <MarginNotes items={items} placement="inline" />
        </div>
      )}
    </section>
  );
};
