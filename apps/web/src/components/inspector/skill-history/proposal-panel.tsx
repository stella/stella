import { useState } from "react";

import { GitPullRequestIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@stll/ui/popover";
import { ReviewDecisionActions } from "@stll/ui/review/review-decision-actions";
import type { ReviewStatusTone } from "@stll/ui/review/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review/review-status-badge";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";

import type {
  MemberNameLookup,
  SkillProposalStatus,
  SkillProposalSummary,
} from "./skill-history.logic";
import {
  isOpenProposalStatus,
  PROPOSAL_STATUS_LABEL_KEY,
} from "./skill-history.logic";

type ProposalMenuProps = {
  proposals: readonly SkillProposalSummary[];
  openProposalId: string | null;
  authorName: MemberNameLookup;
  onOpenProposal: (proposalId: string) => void;
};

/** Trigger + list of every proposal raised against the skill body. */
export const ProposalMenu = ({
  proposals,
  openProposalId,
  authorName,
  onOpenProposal,
}: ProposalMenuProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const openCount = proposals.filter((proposal) =>
    isOpenProposalStatus(proposal.status),
  ).length;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant={openProposalId ? "outline" : "ghost"}>
            <GitPullRequestIcon className="size-3.5" />
            {t("skillHistory.proposals")}
            {openCount > 0 ? (
              <span className="bg-muted text-muted-foreground ms-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums">
                {format.number(openCount)}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 p-0">
        {proposals.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            {t("skillHistory.proposalsEmpty")}
          </p>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="divide-y">
              {proposals.map((proposal) => (
                <li key={proposal.id}>
                  <button
                    className={cn(
                      "hover:bg-accent/50 flex w-full flex-col gap-0.5 px-3 py-2 text-start",
                      proposal.id === openProposalId && "bg-accent/50",
                    )}
                    onClick={() => {
                      onOpenProposal(proposal.id);
                    }}
                    type="button"
                  >
                    <span className="flex items-center gap-1.5">
                      <ProposalStatusBadge status={proposal.status} />
                      <span className="text-muted-foreground truncate text-[11px]">
                        {t("skillHistory.proposalMeta", {
                          author: authorName(proposal.authorId),
                          date: format.dateTime(new Date(proposal.createdAt), {
                            day: "numeric",
                            month: "short",
                          }),
                        })}
                      </span>
                    </span>
                    <span className="text-foreground text-xs wrap-anywhere">
                      {proposal.summary === ""
                        ? t("skillHistory.proposalNoSummary")
                        : proposal.summary}
                    </span>
                    <span className="text-muted-foreground text-[11px]">
                      {proposal.baseIsCurrent
                        ? t("skillHistory.basedOnCurrent")
                        : t("skillHistory.outOfDate")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
};

export const ProposalStatusBadge = ({
  status,
}: {
  status: SkillProposalStatus;
}) => {
  const t = useTranslations();

  return (
    <ReviewStatusBadge tone={STATUS_TONE[status]} variant="solid">
      {t(PROPOSAL_STATUS_LABEL_KEY[status])}
    </ReviewStatusBadge>
  );
};

/** Where a proposal stands, on the product's shared review palette. Total over
 *  the status vocabulary, so a new status has to state its weight. */
const STATUS_TONE = {
  draft: "neutral",
  proposed: "warning",
  accepted: "success",
  rejected: "neutral",
} as const satisfies Record<SkillProposalStatus, ReviewStatusTone>;

type ProposalActionBarProps = {
  status: SkillProposalStatus;
  /** Seeds the editable summary. The host remounts this bar per proposal. */
  initialSummary: string;
  isAuthor: boolean;
  canManage: boolean;
  /** The skill moved on since the proposal's base; accepting overwrites it. */
  isStale: boolean;
  onSummaryChange: (summary: string) => void;
  onSubmitForReview: () => void;
  onDelete: () => void;
  onAccept: () => void;
  onReject: () => void;
  onBack: () => void;
};

/**
 * Actions for the proposal currently loaded in the editor. Everything but
 * "back to current" disappears once the proposal has been decided.
 */
export const ProposalActionBar = ({
  status,
  initialSummary,
  isAuthor,
  canManage,
  isStale,
  onSummaryChange,
  onSubmitForReview,
  onDelete,
  onAccept,
  onReject,
  onBack,
}: ProposalActionBarProps) => {
  const t = useTranslations();
  const [summary, setSummary] = useState(initialSummary);
  const isOpen = isOpenProposalStatus(status);

  return (
    <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <ProposalStatusBadge status={status} />
      {isAuthor && isOpen ? (
        <Input
          aria-label={t("skillHistory.summaryLabel")}
          className="h-7 min-w-40 flex-1 text-xs"
          onChange={(event) => {
            setSummary(event.currentTarget.value);
            onSummaryChange(event.currentTarget.value);
          }}
          placeholder={t("skillHistory.summaryPlaceholder")}
          value={summary}
        />
      ) : (
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {summary === "" ? t("skillHistory.proposalNoSummary") : summary}
        </p>
      )}
      {isAuthor && status === "draft" ? (
        <Button onClick={onSubmitForReview} size="xs">
          {t("skillHistory.submitForReview")}
        </Button>
      ) : null}
      {canManage && isOpen ? (
        <ReviewDecisionActions
          acceptLabel={
            isStale ? t("skillHistory.acceptStale") : t("common.accept")
          }
          onAccept={onAccept}
          onReject={onReject}
          rejectLabel={t("skillHistory.reject")}
          size="xs"
          state="pending"
        />
      ) : null}
      {isAuthor && isOpen ? (
        <Button onClick={onDelete} size="xs" variant="destructive-outline">
          {t("common.delete")}
        </Button>
      ) : null}
      <Button onClick={onBack} size="xs" variant="ghost">
        {t("skillHistory.backToCurrent")}
      </Button>
    </div>
  );
};
