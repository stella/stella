import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";

import { weekOf } from "@/components/billing/work-week.logic";
import { PendingDate, PendingText } from "@/components/pending-text";

export const WeekNavigatorFrame = ({
  today,
  previous,
  next,
  range,
}: {
  today: ReactNode;
  previous: ReactNode;
  next: ReactNode;
  range: ReactNode;
}) => (
  <div className="flex items-center gap-1">
    {today}
    {previous}
    <div className="flex min-w-36 justify-center tabular-nums">{range}</div>
    {next}
  </div>
);

export const WeekNavigatorFace = ({ date }: { date?: string | undefined }) => {
  const week = date === undefined ? undefined : weekOf(date);
  return (
    <WeekNavigatorFrame
      today={
        <ButtonFace size="sm" variant="outline">
          <PendingText id="common.today" barClassName="w-9" />
        </ButtonFace>
      }
      previous={
        <ButtonFace size="icon-sm" variant="ghost">
          <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
        </ButtonFace>
      }
      range={
        <span
          aria-hidden="true"
          className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-sm opacity-64"
        >
          {week === undefined ? (
            <FaceLabelPending className="w-24" />
          ) : (
            <>
              <PendingDate date={week.start} />
              <span aria-hidden="true">–</span>
              <PendingDate date={week.end} />
            </>
          )}
        </span>
      }
      next={
        <ButtonFace size="icon-sm" variant="ghost">
          <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
        </ButtonFace>
      }
    />
  );
};
