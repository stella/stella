import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AiActionIcon, MessageSquareIcon, PlusIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { ProposalMenu } from "./proposal-panel";
import { RevisionMenu } from "./revision-menu";
import type {
  MemberNameLookup,
  SkillProposalSummary,
  SkillRevisionSummary,
} from "./skill-history.logic";

type SkillBodyToolbarProps = {
  title?: string | undefined;
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
  /** Bundled bodies are replaced on update, so they take no proposals. */
  isProposable: boolean;
  onPropose: () => void;
  onSuggestImprovements?: () => void;
  suggestingImprovements?: boolean;
};

/** The review affordances above the body: history, comments, proposals. */
export const SkillBodyToolbar = ({
  title,
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
  onSuggestImprovements,
  suggestingImprovements = false,
}: SkillBodyToolbarProps) => {
  const t = useTranslations();

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      {title ? (
        <span className="text-foreground me-auto text-sm font-medium">
          {title}
        </span>
      ) : null}
      {isProposable && onSuggestImprovements ? (
        <Button
          disabled={suggestingImprovements}
          disabledReason={t("skillHistory.suggestingImprovements")}
          onClick={onSuggestImprovements}
          size="xs"
          variant="outline"
        >
          {suggestingImprovements ? (
            <Loader size="sm" variant="decorative" />
          ) : (
            <AiActionIcon className="size-3.5" />
          )}
          {suggestingImprovements
            ? t("skillHistory.suggestingImprovements")
            : t("skillHistory.suggestImprovements")}
        </Button>
      ) : null}
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
      {isProposable && !canManage ? (
        <Button onClick={onPropose} size="xs" variant="ghost">
          <PlusIcon className="size-3.5" />
          {t("skillHistory.proposeChange")}
        </Button>
      ) : null}
    </div>
  );
};
