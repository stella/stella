/**
 * Why a claim's grade may no longer stand, in its detail panel: one line
 * per reason (its chip and the fact it is about) and the re-check that
 * brings the grade up to date. Nothing re-grades on its own.
 */

import { useTranslations } from "use-intl";

import { ReviewOutOfDateNotice } from "@stll/ui/review-out-of-date-notice";
import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  STALENESS_REASON_META,
  stalenessTone,
} from "@/features/avt/staleness.logic";
import type { VerificationClaim } from "@/features/avt/types";
import type { ClaimRecheckRun } from "@/features/avt/use-bulk-recheck";
import { useClaimRecheckPending } from "@/features/avt/use-claim-gap-actions";

type ClaimStalenessProps = {
  workspaceId: string;
  runId: string;
  listId: string;
  claim: VerificationClaim;
  disabled: boolean;
  /** The claim's place in the run's re-check of claims, which its own
   *  re-check goes through. */
  recheckRun: ClaimRecheckRun;
};

export const ClaimStaleness = ({
  workspaceId,
  runId,
  listId,
  claim,
  disabled,
  recheckRun,
}: ClaimStalenessProps) => {
  const t = useTranslations();
  // A re-check sent from the claim's linked facts keeps this one busy too.
  const singlePending = useClaimRecheckPending({
    workspaceId,
    runId,
    listId,
    claimId: claim.id,
  });
  const withOthers = recheckRun.state === "with-others";
  const reasons = claim.staleness;
  if (reasons === null || reasons.length === 0) {
    return null;
  }
  return (
    <ReviewOutOfDateNotice
      actionDisabled={disabled || withOthers}
      actionDisabledReason={
        withOthers ? t("avt.staleness.recheckLocked") : undefined
      }
      actionLabel={t("avt.gap.recheck")}
      actionPending={recheckRun.state === "alone" || singlePending}
      className="mb-0"
      onAction={recheckRun.start}
      reasons={reasons.map((reason) => {
        const meta = STALENESS_REASON_META[reason.kind];
        return {
          id: `${reason.kind}:${reason.factEntityId}`,
          label: (
            // Two lines of the fact: an edit is often a date or a sum near
            // its end, which one line would cut off.
            <span className="flex min-w-0 items-start gap-2">
              <ReviewStatusBadge
                className="shrink-0"
                icon={<ReviewStatusDot tone={meta.tone} />}
                size="sm"
                tone={meta.tone}
              >
                {t(meta.labelKey)}
              </ReviewStatusBadge>
              <TruncatedText
                className="text-foreground min-w-0 flex-1 pt-px"
                lines={2}
              >
                <bdi>{reason.text}</bdi>
              </TruncatedText>
            </span>
          ),
        };
      })}
      tone={stalenessTone(reasons)}
    />
  );
};
