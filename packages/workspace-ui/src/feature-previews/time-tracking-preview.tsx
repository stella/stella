import { ClockIcon, SquareIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import {
  formatPreviewDate,
  formatPreviewDuration,
  formatPreviewTime,
} from "./format";
import { PREVIEW_MATTERS } from "./mock-data";
import type { PreviewMatter } from "./mock-data";
import { FeaturePreviewSurface } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type TimeTrackingPreviewLabels = {
  /** Title of the time-tracking surface. */
  time: string;
  /** Label of the day's total row. */
  summary: string;
};

export type TimeTrackingPreviewEntry = {
  /** `HH:MM`; `start` is unique within the day. */
  start: string;
  end: string;
  minutes: number;
  description: string;
  matter: PreviewMatter;
};

/** The day's content: the running timer (its elapsed time frozen, since a
 *  static scene shows one moment) and the entries already recorded. The
 *  day's total is computed. */
export type TimeTrackingPreviewData = {
  /** `YYYY-MM-DD`. */
  day: string;
  running: {
    description: string;
    matter: PreviewMatter;
    elapsedMinutes: number;
  };
  /** In the order they were worked. */
  entries: readonly TimeTrackingPreviewEntry[];
};

/** A running timer on a matter above the day's recorded entries and their
 *  total. */
export const TimeTrackingPreview = ({
  labels,
  locale,
  data: { day, running, entries } = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<TimeTrackingPreviewLabels, TimeTrackingPreviewData>) => {
  const totalMinutes =
    entries.reduce((sum, entry) => sum + entry.minutes, 0) +
    running.elapsedMinutes;

  return (
    <FeaturePreviewSurface
      className={className}
      icon={<ClockIcon className="text-muted-foreground size-4 shrink-0" />}
      meta={
        <span className="whitespace-nowrap">
          {formatPreviewDate({
            locale,
            date: day,
            options: { weekday: "long", day: "numeric", month: "long" },
          })}
        </span>
      }
      title={labels.time}
    >
      <div className="flex h-full min-h-0 flex-col gap-3 p-3">
        <div className="bg-card flex min-w-0 items-center gap-3 rounded-lg border p-3 shadow-xs">
          <span className="relative flex size-2 shrink-0">
            <span className="bg-success absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" />
            <span className="bg-success relative size-2 rounded-full" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium">
              {running.description}
            </span>
            <PreviewMatterLabel matter={running.matter} />
          </div>
          <span className="shrink-0 text-xl font-medium tabular-nums">
            {formatPreviewDuration(locale, running.elapsedMinutes)}
          </span>
          <span className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <SquareIcon className="size-3 fill-current" />
          </span>
        </div>
        <ul className="flex min-h-0 flex-col divide-y">
          {entries.map((entry) => (
            <li
              className="flex min-w-0 items-center gap-3 py-2"
              key={entry.start}
            >
              <span className="text-muted-foreground w-24 shrink-0 whitespace-nowrap tabular-nums">
                {formatPreviewTime(locale, entry.start)}–
                {formatPreviewTime(locale, entry.end)}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">{entry.description}</span>
                <PreviewMatterLabel matter={entry.matter} />
              </div>
              <span className="shrink-0 tabular-nums">
                {formatPreviewDuration(locale, entry.minutes)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
          <span>{labels.summary}</span>
          <span className="tabular-nums">
            {formatPreviewDuration(locale, totalMinutes)}
          </span>
        </div>
      </div>
    </FeaturePreviewSurface>
  );
};

const PreviewMatterLabel = ({ matter }: { matter: PreviewMatter }) => (
  <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
    <MatterIcon className="size-3 shrink-0" matter={matter} />
    <span className="truncate">{matter.name}</span>
  </span>
);

// The default content; see `mock-data.ts`.
const DEFAULT_DATA = {
  day: "2026-10-19",
  running: {
    description: "Prepare witness statements",
    matter: PREVIEW_MATTERS.cargo,
    elapsedMinutes: 84,
  },
  entries: [
    {
      start: "08:30",
      end: "09:15",
      minutes: 45,
      description: "Review disclosure list",
      matter: PREVIEW_MATTERS.cargo,
    },
    {
      start: "09:30",
      end: "11:00",
      minutes: 90,
      description: "Mark up share purchase agreement",
      matter: PREVIEW_MATTERS.acquisition,
    },
    {
      start: "11:15",
      end: "11:45",
      minutes: 30,
      description: "Call with landlord's solicitors",
      matter: PREVIEW_MATTERS.lease,
    },
  ],
} as const satisfies TimeTrackingPreviewData;
