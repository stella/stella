import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { ProposalMenu } from "./proposal-panel";
import { RevisionMenu } from "./revision-menu";
import type {
  MemberNameLookup,
  SkillProposalSummary,
  SkillRevisionSummary,
} from "./skill-history.logic";

type SkillBodyToolbarProps = {
  revisions: readonly SkillRevisionSummary[];
  comparedRevisionId: string | null;
  canManage: boolean;
  authorName: MemberNameLookup;
  onCompare: (revisionId: string | null) => void;
  onRestore: (revisionId: string) => void;
  commenting: boolean;
  onToggleComments: () => void;
  proposals: readonly SkillProposalSummary[];
  openProposalId: string | null;
  onOpenProposal: (proposalId: string) => void;
  /** Bundled and built-in bodies are replaced on update, so they take no proposals. */
  isProposable: boolean;
  onPropose: () => void;
};

/** The review affordances above the body: history, comments, proposals. */
export const SkillBodyToolbar = ({
  revisions,
  comparedRevisionId,
  canManage,
  authorName,
  onCompare,
  onRestore,
  commenting,
  onToggleComments,
  proposals,
  openProposalId,
  onOpenProposal,
  isProposable,
  onPropose,
}: SkillBodyToolbarProps) => {
  const t = useTranslations();

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
      <RevisionMenu
        authorName={authorName}
        canManage={canManage}
        comparedRevisionId={comparedRevisionId}
        onCompare={onCompare}
        onRestore={onRestore}
        revisions={revisions}
      />
      <Button
        onClick={onToggleComments}
        size="xs"
        variant={commenting ? "outline" : "ghost"}
      >
        <MessageSquareIcon className="size-3.5" />
        {t("skillHistory.comments")}
      </Button>
      <ProposalMenu
        authorName={authorName}
        onOpenProposal={onOpenProposal}
        openProposalId={openProposalId}
        proposals={proposals}
      />
      {isProposable ? (
        <Button
          className="ms-auto"
          onClick={onPropose}
          size="xs"
          variant="ghost"
        >
          <PlusIcon className="size-3.5" />
          {t("skillHistory.proposeChange")}
        </Button>
      ) : null}
    </div>
  );
};
