/**
 * What a run took from the previous run of its document, as one small
 * control beside the run's date: how many reviews came across and how many
 * did not. It opens the claims that did not, each of which shows its claim
 * in this run when it has one, and a way to open that earlier run.
 */

import * as React from "react";

import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import type {
  NotCarriedClaim,
  RunCarryOver,
  VerificationClaim,
} from "@/features/avt/types";
import { NOT_CARRIED_LABEL_KEYS } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type RunCarryOverControlProps = {
  carryOver: RunCarryOver;
  onOpenRun: (runId: string) => void;
  /** Select a claim of this run and bring it into view. */
  onShowClaim: (claimId: VerificationClaim["id"]) => void;
};

export const RunCarryOverControl = ({
  carryOver,
  onOpenRun,
  onShowClaim,
}: RunCarryOverControlProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = React.useState(false);
  // The run picker names runs the same way, so the reviewer can find it.
  const date = format.dateTime(
    Temporal.Instant.from(carryOver.sourceRunCreatedAt).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  const carried = carryOver.carriedCount;
  const missed = carryOver.notCarried.length;
  const summary = (() => {
    if (missed === 0) {
      return t("avt.runs.carryOver.summary.carried", { count: carried });
    }
    if (carried === 0) {
      return t("avt.runs.carryOver.summary.missed", { count: missed });
    }
    return t("avt.runs.carryOver.summary.carriedAndMissed", {
      carried,
      missed,
    });
  })();

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={t("avt.runs.carryOver.summary.label", {
          date,
          carried,
          missed,
        })}
        render={<Button size="sm" variant="ghost" />}
      >
        <span className="tabular-nums">{summary}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(26rem,calc(100vw-2rem))]">
        {missed > 0 && (
          <ScrollArea axis="vertical" className="-mx-2 -mt-1 mb-2 max-h-80">
            <ul className="space-y-0.5">
              {carryOver.notCarried.map((claim) => (
                <li key={claim.sourceClaimId}>
                  <NotCarriedRow
                    claim={claim}
                    onShow={(claimId) => {
                      setOpen(false);
                      onShowClaim(claimId);
                    }}
                  />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
        <div className={cn("-mx-2", missed > 0 ? "border-t pt-2" : "-my-1")}>
          <Button
            onClick={() => {
              setOpen(false);
              onOpenRun(carryOver.sourceRunId);
            }}
            size="sm"
            variant="ghost"
          >
            {t("avt.runs.carryOver.openSource", { date })}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type NotCarriedRowProps = {
  claim: NotCarriedClaim;
  onShow: (claimId: VerificationClaim["id"]) => void;
};

/** A claim whose decisions stayed behind: its words, then why. One that
 *  matched a claim of this run shows it; one that matched none cannot. */
const NotCarriedRow = ({ claim, onShow }: NotCarriedRowProps) => {
  const t = useTranslations();
  const body = (
    <>
      <span className="line-clamp-2 font-serif text-sm" dir="auto">
        {claim.text}
      </span>
      <span className="text-muted-foreground block text-xs">
        {t(NOT_CARRIED_LABEL_KEYS[claim.outcome])}
      </span>
    </>
  );
  const targetClaimId = claim.targetClaimId;
  if (targetClaimId === null) {
    return <div className="space-y-0.5 px-2 py-1.5 text-start">{body}</div>;
  }
  return (
    <Button
      className="group/plain flex w-full"
      onClick={() => onShow(targetClaimId)}
      variant="plain"
    >
      <span className="group-hover/plain:bg-muted block w-full space-y-0.5 rounded-md px-2 py-1.5 text-start">
        {body}
      </span>
    </Button>
  );
};
