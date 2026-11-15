import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Button } from "../../components/button";
import { DayCalendar } from "../day-calendar";
import type {
  DayCalendarBlock,
  DayCalendarColumn,
  DayCalendarSelection,
} from "../day-calendar";
import {
  DAY_CALENDAR_GRANULARITIES,
  getDayBounds,
  mergeShortSegments,
} from "../day-calendar.logic";
import type {
  DayCalendarGranularity,
  DayCalendarRange,
} from "../day-calendar.logic";

// Query parameters pick the screenshot state: `variant=locked` swaps the
// activity column for the locked placeholder, `dir=rtl` mirrors the chrome,
// `theme=dark` switches the palette, `locale` sets the hour labels.
const params = new URLSearchParams(window.location.search);
const variant = params.get("variant") === "locked" ? "locked" : "activity";
const locale = params.get("locale") ?? "en-GB";
document.documentElement.dir = params.get("dir") === "rtl" ? "rtl" : "ltr";
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);

const TIME_ZONE = "Europe/Prague";
const DATE = "2026-10-30";
const HOURS = { endHour: 15, startHour: 8 };
const dayStart = getDayBounds({
  date: DATE,
  ...HOURS,
  timeZone: TIME_ZONE,
}).startMs;
const at = (hour: number, minute = 0) =>
  dayStart + ((hour - HOURS.startHour) * 60 + minute) * 60_000;
const NOW = at(11, 40);

const SERVICE_AGREEMENT = {
  color: "--option-teal",
  matterId: "matter-service-agreement",
  type: "matter",
} as const;
const LEASE_RENEWAL = {
  color: "--option-violet",
  matterId: "matter-lease-renewal",
  type: "matter",
} as const;

type ActivitySegment = DayCalendarRange & { app: string; id: string };

const ACTIVITY: ActivitySegment[] = [
  { app: "Editor", endMs: at(8, 40), id: "a1", startMs: at(8, 5) },
  { app: "Terminal", endMs: at(8, 44), id: "a2", startMs: at(8, 40) },
  { app: "Browser", endMs: at(8, 47), id: "a3", startMs: at(8, 44) },
  { app: "Mail", endMs: at(8, 52), id: "a4", startMs: at(8, 47) },
  { app: "Browser", endMs: at(9, 0), id: "a5", startMs: at(8, 52) },
  { app: "Browser", endMs: at(9, 30), id: "a6", startMs: at(9, 5) },
  { app: "Editor", endMs: at(10, 10), id: "a7", startMs: at(9, 30) },
  { app: "Mail", endMs: at(10, 45), id: "a8", startMs: at(10, 10) },
  { app: "Video call", endMs: at(11, 40), id: "a9", startMs: at(11) },
];

const ACTIVITY_TITLES: Record<string, string> = {
  a1: "Editor · Service agreement draft",
  a6: "Browser · Land registry extract",
  a7: "Editor · Service agreement draft",
  a8: "Mail · Comments on the agreement",
  a9: "Video call · Lease renewal",
};

const ACTIVITY_TONES: Record<string, DayCalendarBlock["tone"]> = {
  a1: SERVICE_AGREEMENT,
  a7: SERVICE_AGREEMENT,
  a9: LEASE_RENEWAL,
};

const activityBlocks = mergeShortSegments(ACTIVITY, {
  thresholdMs: 10 * 60_000,
}).map((merged): DayCalendarBlock => {
  if (merged.type === "mixed") {
    const apps = [...new Set(merged.sources.map(({ app }) => app))].join(" · ");
    return {
      accessibleLabel: `Rapid switching: ${apps}`,
      caption: `${apps} · ${String(merged.sources.length)}×`,
      endMs: merged.endMs,
      id: merged.id,
      kind: "mixed",
      startMs: merged.startMs,
      title: "Rapid switching",
      tone: { type: "neutral" },
    };
  }
  const title = ACTIVITY_TITLES[merged.segment.id] ?? merged.segment.app;
  return {
    accessibleLabel: title,
    endMs: merged.segment.endMs,
    id: merged.segment.id,
    kind: "segment",
    startMs: merged.segment.startMs,
    title,
    tone: ACTIVITY_TONES[merged.segment.id] ?? { type: "neutral" },
  };
});

const entryBlocks: DayCalendarBlock[] = [
  {
    accessibleLabel: "Service agreement review, draft",
    caption: "Review of the draft service agreement",
    endMs: at(9, 5),
    id: "e1",
    kind: "entry",
    startMs: at(8, 5),
    state: "draft",
    title: "Service agreement review",
    tone: SERVICE_AGREEMENT,
  },
  {
    accessibleLabel: "Lease renewal call",
    caption: "Call with the landlord",
    endMs: at(11, 40),
    id: "e2",
    kind: "entry",
    startMs: at(11),
    state: "final",
    title: "Lease renewal",
    tone: LEASE_RENEWAL,
  },
];

const INITIAL_SELECTION = {
  columnId: "activity",
  range: { endMs: at(10, 45), startMs: at(9, 30) },
};

const DayCalendarFixture = () => {
  const [granularity, setGranularity] = useState<DayCalendarGranularity>(15);
  const [selection, setSelection] = useState<Omit<
    DayCalendarSelection,
    "panel"
  > | null>(INITIAL_SELECTION);

  useEffect(() => {
    document.documentElement.dataset["dayCalendarReady"] = "true";
    return () => {
      delete document.documentElement.dataset["dayCalendarReady"];
    };
  }, []);

  const activityColumn: DayCalendarColumn =
    variant === "locked"
      ? {
          action: (
            <div className="bg-popover border-border flex max-w-72 flex-col items-center gap-2 rounded-xl border p-4 text-center shadow-lg">
              <span className="text-sm font-semibold">
                Activity stays on this computer
              </span>
              <span className="text-muted-foreground text-xs">
                The browser reads it from the desktop app.
              </span>
              <Button size="sm">Show activity</Button>
            </div>
          ),
          badge: "this computer",
          id: "activity",
          label: "Activity",
          type: "locked",
        }
      : {
          badge: "this computer",
          blocks: activityBlocks,
          id: "activity",
          label: "Activity",
          rangeSelection: {
            label: "Select a time range in Activity",
            type: "enabled",
          },
          type: "blocks",
        };

  return (
    <main className="flex flex-col gap-4 p-6" data-day-calendar-fixture>
      <label className="text-muted-foreground flex items-center gap-2 self-end text-xs">
        Grid
        <select
          className="border-input bg-popover h-8 rounded-md border px-2 text-sm"
          data-testid="granularity"
          onChange={(event) => {
            const next = DAY_CALENDAR_GRANULARITIES.find(
              (value) => String(value) === event.target.value,
            );
            if (next !== undefined) {
              setGranularity(next);
            }
          }}
          value={granularity}
        >
          {DAY_CALENDAR_GRANULARITIES.map((value) => (
            <option key={value} value={value}>
              {value} min
            </option>
          ))}
        </select>
      </label>
      <DayCalendar
        ariaLabel="Friday"
        columns={[
          activityColumn,
          {
            blocks: entryBlocks,
            id: "entries",
            label: "Time entries",
            rangeSelection: {
              label: "Select a time range in Time entries",
              type: "enabled",
            },
            type: "blocks",
          },
        ]}
        date={DATE}
        granularity={granularity}
        hours={HOURS}
        locale={locale}
        nowMs={NOW}
        onSelectRange={(columnId, range) => setSelection({ columnId, range })}
        selection={
          selection === null
            ? null
            : {
                ...selection,
                panel: {
                  columnId: "entries",
                  content: (
                    <form
                      aria-label="New entry"
                      className="bg-popover border-border flex flex-col gap-3 rounded-xl border p-3 text-sm shadow-lg"
                      onSubmit={(event) => event.preventDefault()}
                    >
                      <span className="font-semibold">New entry</span>
                      <span className="text-muted-foreground text-xs">
                        Service agreement review
                      </span>
                      <div className="flex justify-end gap-2">
                        <Button
                          onClick={() => setSelection(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                        <Button size="sm" type="submit">
                          Save draft
                        </Button>
                      </div>
                    </form>
                  ),
                },
              }
        }
        timeZone={TIME_ZONE}
      />
    </main>
  );
};

const root = document.querySelector("#root");
if (!root) {
  panic("Missing fixture root");
}

createRoot(root).render(<DayCalendarFixture />);
