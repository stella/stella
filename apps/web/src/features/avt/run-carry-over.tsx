/**
 * What a run took from the previous run of its document, as one quiet line
 * under the run header: how many reviews came across, and how many did not,
 * which opens the list of those claims and why each stayed behind.
 */

import * as React from "react";

import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";

import type { RunCarryOver } from "@/features/avt/types";
import { NOT_CARRIED_LABEL_KEYS } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type RunCarryOverNoteProps = {
  carryOver: RunCarryOver;
  onOpenRun: (runId: string) => void;
};

export const RunCarryOverNote = ({
  carryOver,
  onOpenRun,
}: RunCarryOverNoteProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = React.useState(false);
  // The run picker names runs the same way, so the reviewer can find it.
  const date = format.dateTime(
    Temporal.Instant.from(carryOver.sourceRunCreatedAt).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  const notCarried = carryOver.notCarried;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3">
      <span>
        {t("avt.runs.carryOver.carried", {
          count: carryOver.carriedCount,
          date,
        })}
      </span>
      {notCarried.length > 0 && (
        <span>
          <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger
              render={<Button className="-mx-1.5" size="xs" variant="ghost" />}
            >
              <span className="tabular-nums">
                {t("avt.runs.carryOver.notCarried", {
                  count: notCarried.length,
                })}
              </span>
            </PopoverTrigger>
            <PopoverPopup
              align="start"
              className="w-[min(26rem,calc(100vw-2rem))]"
            >
              <ScrollArea axis="vertical" className="-my-1 max-h-80">
                <ol className="divide-y">
                  {notCarried.map((claim) => (
                    <li className="space-y-0.5 py-2" key={claim.sourceClaimId}>
                      <p className="line-clamp-2 font-serif text-sm" dir="auto">
                        {claim.text}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t(NOT_CARRIED_LABEL_KEYS[claim.outcome])}
                      </p>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
              <div className="mt-2 border-t pt-2">
                <Button
                  className="-ms-2.5"
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
        </span>
      )}
    </span>
  );
};
