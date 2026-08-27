import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { MarkdownEditorComment } from "@/components/markdown/markdown-hybrid-editor";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import { toEditorMarkdown } from "@/components/skill-body-markdown";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import {
  skillCommentsOptions,
  skillDetailOptions,
  skillProposalsOptions,
  skillRevisionOptions,
  skillRevisionsOptions,
} from "@/lib/knowledge/queries";
import { organizationOptions } from "@/lib/organization/queries";

import { CommentList } from "./comment-list";
import { ProposalReview } from "./proposal-review";
import { SkillBodyToolbar } from "./skill-body-toolbar";
import type { SkillCommentRow } from "./skill-history.logic";
import {
  canManageSkill,
  createMemberNameLookup,
  isProposableOrigin,
} from "./skill-history.logic";
import { useSkillHistoryActions } from "./use-skill-history-actions";

/**
 * What the editor pane is showing. Comparing against a revision and commenting
 * both apply to the live body; opening a proposal replaces it entirely.
 */
type BodyMode =
  | { type: "live"; compareRevisionId: string | null; commenting: boolean }
  | { type: "proposal"; proposalId: string };

const LIVE_MODE: BodyMode = {
  type: "live",
  compareRevisionId: null,
  commenting: false,
};

// Stable empty list while a query has no data yet: a fresh `[]` per render
// would defeat memoized children.
const NO_ROWS: readonly never[] = [];

const NO_EDITOR_COMMENTS: readonly MarkdownEditorComment[] = [];

type SkillBodyWorkspaceProps = {
  /**
   * Length of the frontmatter block the editor never shows. Comment offsets
   * are stored against the full stored body (what the server validates), so
   * every editor offset is shifted by this on the way out and back.
   */
  frontmatterLength: number;
  skillId: string;
  /** The live body in editor form (frontmatter already stripped). */
  liveMarkdown: string;
  /** Debounced autosave of the live body. Only reachable for managers. */
  onPersistBody: (editorMarkdown: string) => void;
  /** Writes the given text over the live body and syncs the open tab. */
  onRestoreBody: (editorMarkdown: string) => void;
  /** Syncs the open tab with a body the server already holds. */
  onAdoptBody: (editorMarkdown: string) => void;
};

/**
 * The SKILL.md body with its review surface: revision history and diffing,
 * range comments, and change proposals.
 *
 * Only the people who may edit the skill get the live autosaving editor. For
 * everyone else the live body is read-only and a proposal is the way to change
 * it, which keeps the client's affordances in step with what the API allows.
 */
export const SkillBodyWorkspace = ({
  skillId,
  frontmatterLength,
  liveMarkdown,
  onPersistBody,
  onRestoreBody,
  onAdoptBody,
}: SkillBodyWorkspaceProps) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const organizationId = user.activeOrganizationId;
  const [mode, setMode] = useState<BodyMode>(LIVE_MODE);
  // The engine reads its text once per mount, so a body replaced underneath it
  // (a restore, an accepted proposal) needs a fresh instance.
  const [editorGeneration, setEditorGeneration] = useState(0);

  const detail = useQuery(skillDetailOptions(organizationId, skillId));
  const role = useQuery(roleOptions);
  const organization = useQuery(organizationOptions(organizationId));
  const revisions = useQuery(skillRevisionsOptions(organizationId, skillId));
  const proposals = useQuery(skillProposalsOptions(organizationId, skillId));

  const compareRevisionId =
    mode.type === "live" ? mode.compareRevisionId : null;
  const comparedRevision = useQuery(
    skillRevisionOptions(organizationId, skillId, compareRevisionId),
  );

  const openProposalId = mode.type === "proposal" ? mode.proposalId : null;

  const commenting = mode.type === "live" && mode.commenting;
  const comments = useQuery({
    ...skillCommentsOptions(organizationId, skillId),
    enabled: commenting,
  });

  const actions = useSkillHistoryActions({ organizationId, skillId });

  const authorName = createMemberNameLookup({
    members: organization.data?.members,
    fallback: t("common.unknownUser"),
  });
  const isProposable =
    detail.data !== undefined && isProposableOrigin(detail.data.origin);
  const canManage =
    detail.data !== undefined &&
    canManageSkill({
      scope: detail.data.scope,
      ownerUserId: detail.data.userId,
      memberRole: role.data,
      userId: user.id,
    });

  // Every body change records a revision, so the newest one is what the live
  // text corresponds to; comment mode is read-only, so the text cannot drift
  // while a comment is being written.
  const latestRevisionId = revisions.data?.items.at(0)?.id ?? null;
  const bodyComments = (comments.data?.items ?? NO_ROWS).filter(
    (comment) => comment.proposalId === null,
  );
  // Only the open comments written against the revision the live text
  // corresponds to can be placed: an older comment's offsets describe text that
  // has since changed, and there is no re-anchoring yet. The comments query is
  // disabled outside comment mode, but its cache survives, so the projection is
  // gated on the mode rather than on the data being present.
  const editorComments: readonly MarkdownEditorComment[] = commenting
    ? bodyComments
        .filter(
          (comment) =>
            comment.revisionId === latestRevisionId &&
            comment.resolvedAt === null &&
            comment.rangeStart >= frontmatterLength,
        )
        .map((comment) => ({
          id: comment.id,
          start: comment.rangeStart - frontmatterLength,
          end: comment.rangeEnd - frontmatterLength,
          body: comment.body,
          author: authorName(comment.authorId),
        }))
    : NO_EDITOR_COMMENTS;

  const restoreRevision = (revisionId: string) => {
    const revision = comparedRevision.data;
    if (revision === undefined || revision.id !== revisionId) {
      return;
    }
    onRestoreBody(toEditorMarkdown(revision.body));
    setMode(LIVE_MODE);
    setEditorGeneration((generation) => generation + 1);
  };

  const addComment = ({
    start,
    end,
    text,
  }: {
    start: number;
    end: number;
    text: string;
  }) => {
    if (latestRevisionId === null) {
      return;
    }
    detached(
      actions.addComment({
        revisionId: latestRevisionId,
        start: start + frontmatterLength,
        end: end + frontmatterLength,
        body: text,
      }),
      "skill-history.add-comment",
    );
  };

  const toggleResolved = (comment: SkillCommentRow) => {
    detached(
      actions.setCommentResolved(comment.id, comment.resolvedAt === null),
      "skill-history.resolve-comment",
    );
  };

  const deleteComment = (commentId: string) => {
    detached(actions.deleteComment(commentId), "skill-history.delete-comment");
  };

  const proposeChange = async () => {
    const proposalId = await actions.createProposal();
    if (proposalId !== null) {
      setMode({ type: "proposal", proposalId });
    }
  };

  const closeProposal = (adoptedBody: string | null) => {
    if (adoptedBody !== null) {
      onAdoptBody(adoptedBody);
      setEditorGeneration((generation) => generation + 1);
    }
    setMode(LIVE_MODE);
  };

  return (
    <>
      <SkillBodyToolbar
        authorName={authorName}
        canManage={canManage}
        commenting={commenting}
        comparedRevisionId={compareRevisionId}
        isProposable={isProposable}
        onCompare={(revisionId) => {
          setMode({
            type: "live",
            compareRevisionId: revisionId,
            commenting: false,
          });
        }}
        onOpenProposal={(proposalId) => {
          setMode({ type: "proposal", proposalId });
        }}
        onPropose={() => {
          detached(proposeChange(), "skill-history.propose");
        }}
        onRestore={restoreRevision}
        onToggleComments={() => {
          setMode({
            type: "live",
            compareRevisionId,
            commenting: !commenting,
          });
        }}
        openProposalId={openProposalId}
        proposals={proposals.data?.items ?? NO_ROWS}
        revisions={revisions.data?.items ?? NO_ROWS}
      />
      {commenting ? (
        <CommentList
          authorName={authorName}
          canManage={canManage}
          comments={bodyComments}
          currentRevisionId={latestRevisionId}
          onDelete={deleteComment}
          onToggleResolved={toggleResolved}
          userId={user.id}
        />
      ) : null}
      {mode.type === "proposal" ? (
        <ProposalReview
          canManage={canManage}
          key={mode.proposalId}
          onClose={closeProposal}
          organizationId={organizationId}
          proposalId={mode.proposalId}
          skillId={skillId}
          userId={user.id}
        />
      ) : (
        <MarkdownHybridEditor
          baseline={
            comparedRevision.data === undefined
              ? undefined
              : toEditorMarkdown(comparedRevision.data.body)
          }
          comments={editorComments}
          key={`live:${String(editorGeneration)}:${String(commenting)}`}
          markdown={liveMarkdown}
          onMarkdownChange={onPersistBody}
          readOnly={!canManage || commenting}
          {...(commenting
            ? { onAddComment: addComment, onDeleteComment: deleteComment }
            : {})}
        />
      )}
    </>
  );
};
