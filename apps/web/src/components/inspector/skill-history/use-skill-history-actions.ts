import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";

import { createSerializedSaver } from "./serialized-save";
import type { SkillProposalStatus } from "./skill-history.logic";

// The comment endpoint stores the quoted source alongside the offsets so the
// comment survives the text moving on; it is capped server-side.
const ANCHOR_TEXT_MAX_CHARS = 2000;

/** The statuses an author may write directly, as opposed to a review decision. */
type AuthoringProposalStatus = Extract<
  SkillProposalStatus,
  "draft" | "proposed"
>;

type SkillHistoryActionsOptions = {
  organizationId: string;
  skillId: string;
};

type AddCommentInput = {
  revisionId: string;
  start: number;
  end: number;
  anchorText: string;
  body: string;
};

type ReviewProposalInput = {
  proposalId: string;
  decision: "accepted" | "rejected";
  /** Accept even though the skill changed since the proposal's base. */
  allowStale?: boolean;
};

/**
 * Every write the skill history surface makes: comments, proposals, and the
 * proposal body/summary autosave. Each one invalidates the query keys it
 * invalidates and reports failures as a toast, so callers stay declarative.
 */
export const useSkillHistoryActions = ({
  organizationId,
  skillId,
}: SkillHistoryActionsOptions) => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const skill = api.skills({ skillId: toSafeId<"agentSkill">(skillId) });

  const invalidate = (queryKey: readonly unknown[]) => {
    detached(
      queryClient.invalidateQueries({ queryKey }),
      "skill-history.invalidate",
    );
  };

  const report = (error: Parameters<typeof toAPIError>[0]) => {
    stellaToast.add({
      title: t("common.unexpectedError"),
      description: toAPIError(error).message,
      type: "error",
    });
  };

  const invalidateComments = () => {
    invalidate(knowledgeKeys.skills.comments(organizationId, skillId));
  };
  const invalidateProposals = () => {
    invalidate(knowledgeKeys.skills.proposals(organizationId, skillId));
  };

  const addComment = async ({
    revisionId,
    start,
    end,
    anchorText,
    body,
  }: AddCommentInput) => {
    const response = await skill.comments.post({
      revisionId: toSafeId<"agentSkillRevision">(revisionId),
      rangeStart: start,
      rangeEnd: end,
      anchorText: anchorText.slice(0, ANCHOR_TEXT_MAX_CHARS),
      body,
    });
    if (response.error) {
      report(response.error);
      return;
    }
    invalidateComments();
  };

  const setCommentResolved = async (commentId: string, resolved: boolean) => {
    const response = await skill
      .comments({ commentId: toSafeId<"agentSkillComment">(commentId) })
      .patch({ resolved });
    if (response.error) {
      report(response.error);
      return;
    }
    invalidateComments();
  };

  const deleteComment = async (commentId: string) => {
    const response = await skill
      .comments({ commentId: toSafeId<"agentSkillComment">(commentId) })
      .delete();
    if (response.error) {
      report(response.error);
      return;
    }
    invalidateComments();
  };

  /** Opens a draft branched from the current revision. Returns its id. */
  const createProposal = async (): Promise<string | null> => {
    const response = await skill.proposals.post({});
    if (response.error) {
      report(response.error);
      return null;
    }
    invalidateProposals();
    return response.data.id;
  };

  // Authoring statuses only: a decision goes through `reviewProposal`.
  const setProposalStatus = async (
    proposalId: string,
    status: AuthoringProposalStatus,
  ) => {
    const response = await skill
      .proposals({ proposalId: toSafeId<"agentSkillProposal">(proposalId) })
      .patch({ status });
    if (response.error) {
      report(response.error);
      return;
    }
    invalidateProposals();
    invalidate(
      knowledgeKeys.skills.proposal(organizationId, skillId, proposalId),
    );
  };

  const deleteProposal = async (proposalId: string) => {
    const response = await skill
      .proposals({ proposalId: toSafeId<"agentSkillProposal">(proposalId) })
      .delete();
    if (response.error) {
      report(response.error);
      return;
    }
    invalidateProposals();
  };

  const reviewProposal = async ({
    proposalId,
    decision,
    allowStale = false,
  }: ReviewProposalInput) => {
    const response = await skill
      .proposals({ proposalId: toSafeId<"agentSkillProposal">(proposalId) })
      .review.post({ decision, allowStale });
    if (response.error) {
      report(response.error);
      return false;
    }
    invalidateProposals();
    invalidate(
      knowledgeKeys.skills.proposal(organizationId, skillId, proposalId),
    );
    invalidate(knowledgeKeys.skills.revisions(organizationId, skillId));
    invalidate(knowledgeKeys.skills.detail(organizationId, skillId));
    return true;
  };

  const writeProposalBody = useLatestCallback(
    async (proposalId: string, body: string) => {
      const response = await skill
        .proposals({ proposalId: toSafeId<"agentSkillProposal">(proposalId) })
        .patch({ body });
      if (response.error) {
        report(response.error);
      }
    },
  );
  const writeProposalSummary = useLatestCallback(
    async (proposalId: string, summary: string) => {
      const response = await skill
        .proposals({ proposalId: toSafeId<"agentSkillProposal">(proposalId) })
        .patch({ summary });
      if (response.error) {
        report(response.error);
        return;
      }
      invalidateProposals();
    },
  );

  const [saveProposalBody] = useState(() =>
    createSerializedSaver(writeProposalBody),
  );
  const [saveProposalSummary] = useState(() =>
    createSerializedSaver(writeProposalSummary),
  );

  return {
    addComment,
    createProposal,
    deleteComment,
    deleteProposal,
    reviewProposal,
    saveProposalBody,
    saveProposalSummary,
    setCommentResolved,
    setProposalStatus,
  };
};
