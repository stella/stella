import { useQuery } from "@tanstack/react-query";

import { toEditorMarkdown } from "@/components/skill-body-markdown";
import { detached } from "@/lib/detached";
import { skillProposalOptions } from "@/lib/knowledge/queries";

import { ProposalBodyEditor } from "./proposal-body-editor";
import { ProposalActionBar } from "./proposal-panel";
import { isOpenProposalStatus } from "./skill-history.logic";
import { useSkillHistoryActions } from "./use-skill-history-actions";

type ProposalReviewProps = {
  organizationId: string;
  skillId: string;
  proposalId: string;
  canManage: boolean;
  userId: string;
  /**
   * Return to the live body. `adoptedBody` carries the editor markdown the
   * proposal wrote to the skill when it was accepted, and is null otherwise.
   */
  onClose: (adoptedBody: string | null) => void;
};

/**
 * One proposal open for review: its body diffed against the revision it
 * branched from, plus the actions its author and the skill's managers have on
 * it. Mounted per proposal, so the summary draft and the editor start clean.
 */
export const ProposalReview = ({
  organizationId,
  skillId,
  proposalId,
  canManage,
  userId,
  onClose,
}: ProposalReviewProps) => {
  const actions = useSkillHistoryActions({ organizationId, skillId });
  const { data: proposal } = useQuery(
    skillProposalOptions(organizationId, skillId, proposalId),
  );

  const isAuthor = proposal?.authorId === userId;
  const isOpen =
    proposal !== undefined && isOpenProposalStatus(proposal.status);

  const decide = async (decision: "accepted" | "rejected") => {
    if (proposal === undefined) {
      return;
    }
    const decided = await actions.reviewProposal({ proposalId, decision });
    if (!decided) {
      return;
    }
    onClose(decision === "accepted" ? toEditorMarkdown(proposal.body) : null);
  };

  return (
    <>
      {proposal === undefined ? null : (
        <ProposalActionBar
          canManage={canManage}
          initialSummary={proposal.summary}
          isAuthor={isAuthor}
          onAccept={() => {
            detached(decide("accepted"), "skill-history.accept");
          }}
          onBack={() => {
            onClose(null);
          }}
          onDelete={() => {
            detached(
              actions.deleteProposal(proposalId),
              "skill-history.delete-proposal",
            );
            onClose(null);
          }}
          onReject={() => {
            detached(decide("rejected"), "skill-history.reject");
          }}
          onSubmitForReview={() => {
            detached(
              actions.setProposalStatus(proposalId, "proposed"),
              "skill-history.submit-proposal",
            );
          }}
          onSummaryChange={(summary) => {
            actions.saveProposalSummary(proposalId, summary);
          }}
          status={proposal.status}
        />
      )}
      <ProposalBodyEditor
        editable={isAuthor && isOpen}
        onBodyChange={(editorMarkdown) => {
          actions.saveProposalBody(proposalId, editorMarkdown);
        }}
        proposal={proposal}
      />
    </>
  );
};
