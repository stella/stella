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

/** A running timer on a matter above the day's recorded entries and their
 *  total. */
export const TimeTrackingPreview = ({
  labels,
  locale,
  className,
}: FeaturePreviewProps<TimeTrackingPreviewLabels>) => {
  const totalMinutes =
    ENTRIES.reduce((sum, entry) => sum + entry.minutes, 0) +
    RUNNING.elapsedMinutes;

  return (
    <FeaturePreviewSurface
      className={className}
      icon={<ClockIcon className="text-muted-foreground size-4 shrink-0" />}
      meta={
        <span className="whitespace-nowrap">
          {formatPreviewDate({
            locale,
            date: DAY,
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
              {RUNNING.description}
            </span>
            <PreviewMatterLabel matter={RUNNING.matter} />
          </div>
          <span className="shrink-0 text-xl font-medium tabular-nums">
            {formatPreviewDuration(locale, RUNNING.elapsedMinutes)}
          </span>
          <span className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <SquareIcon className="size-3 fill-current" />
          </span>
        </div>
        <ul className="flex min-h-0 flex-col divide-y">
          {ENTRIES.map((entry) => (
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

// Mock content depicting user data, not interface text; deliberately
// untranslated. The running timer's elapsed time is frozen: a static scene
// shows one moment.
const DAY = "2026-10-19";

const RUNNING = {
  description: "Prepare witness statements",
  matter: PREVIEW_MATTERS.cargo,
  elapsedMinutes: 84,
} as const;

// Chronological, as the day was worked.
const ENTRIES = [
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
] as const;
