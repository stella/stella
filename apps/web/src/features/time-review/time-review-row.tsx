import { useState } from "react";

import { useTranslations } from "use-intl";

import { UNPRICED_TIME_ENTRY_CURRENCY } from "@stll/api-contract";
import type { CentsAmount } from "@stll/money";
import { timeEntryAmount } from "@stll/money";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Input } from "@stll/ui/input";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import type { TimeReview } from "@/features/time-review/use-time-review";
import { useFormatter } from "@/i18n/formatting-context";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-plain-date";

/** What a reviewer sees of one entry, whichever list it came from. */
export type TimeReviewRowData = {
  id: string;
  workspaceId: string | null;
  timekeeperName: string | null;
  matterName: string | null;
  dateWorked: string;
  durationMinutes: number;
  billedMinutes: number;
  rateAtEntry: CentsAmount;
  currency: string;
  noCharge: boolean;
  narrative: string;
  returnComment: string | null;
};

type TimeReviewRowProps = {
  row: TimeReviewRowData;
  review: TimeReview;
  /** Submitted rows can be approved or returned; approved ones only returned. */
  stage: "submitted" | "approved";
  /** Which context columns the surrounding grouping does not already show. */
  show: { timekeeper: boolean; matter: boolean; date: boolean };
};

const Pricing = ({ row }: { row: TimeReviewRowData }) => {
  const t = useTranslations();
  if (row.currency === UNPRICED_TIME_ENTRY_CURRENCY) {
    return <span>{t("billing.rates.noRateFound")}</span>;
  }
  return (
    <>
      <span>{formatCurrencyAmount(row.rateAtEntry, row.currency)}</span>
      <span>{formatCurrencyAmount(timeEntryAmount(row), row.currency)}</span>
    </>
  );
};

/**
 * One entry under review: who, when, which matter, billed time, rate and
 * amount, the narrative, and the reviewer's actions. Returning needs a
 * comment, which the timekeeper then sees beside the entry.
 */
export const TimeReviewRow = ({
  row,
  review,
  stage,
  show,
}: TimeReviewRowProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [comment, setComment] = useState("");
  const busy = review.isPending(row.id);
  const error = review.errors[row.id];

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        {stage === "submitted" && (
          <Checkbox
            aria-label={t("billing.approval.selectEntry")}
            checked={review.isChecked(row.id)}
            onCheckedChange={(value) => review.setChecked(row.id, value)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-x-4 text-sm tabular-nums">
            {show.timekeeper && <strong>{row.timekeeperName}</strong>}
            {show.date && (
              <span>
                {format.dateTime(plainDateEpoch(row.dateWorked), SHORT_DATE)}
              </span>
            )}
            {show.matter && row.matterName !== null && (
              <BidiText as="span">{row.matterName}</BidiText>
            )}
            <span>{formatMinutes(row.billedMinutes)}</span>
            <Pricing row={row} />
          </div>
          <BidiText as="p" className="text-muted-foreground mt-1 text-sm">
            {row.narrative}
          </BidiText>
          {error !== undefined && (
            <p className="text-destructive mt-1 text-sm" role="alert">
              {error}
            </p>
          )}
        </div>
        {stage === "submitted" && (
          <Button
            loading={busy}
            onClick={() => review.approve([row])}
            size="sm"
          >
            {t("billing.approve")}
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <Input
          aria-label={t("billing.approval.returnComment")}
          className="max-w-72"
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("billing.approval.returnComment")}
          value={comment}
        />
        <Button
          disabled={comment.trim() === ""}
          loading={busy}
          onClick={() => review.returnToDraft(row, comment)}
          size="sm"
          variant="outline"
        >
          {t("billing.revertToDraft")}
        </Button>
      </div>
    </li>
  );
};
