import { describe, expect, test } from "bun:test";

import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import {
  activityBlocks,
  appRows,
  BLOCK_DETAIL_APP_LIMIT,
  blockDetails,
  calendarHours,
  contiguousRuns,
  draftedBlocks,
  manualSuggestion,
  matchedSuggestions,
  NARRATIVE_TITLE_LIMIT,
  narrativeTitles,
  nextSuggestion,
  segmentTitles,
  shortSegmentThresholdMs,
  titleRows,
} from "../src/activity/activity-calendar-logic";
import { timedSegments } from "../src/activity/activity-logic";
import type { ActivitySegment } from "../src/activity/activity-types";
import { matchDay } from "../src/activity/day-review-logic";

const MINUTE = 60_000;
const DAY_START = Date.UTC(2026, 9, 9, 8, 0);
const at = (minute: number) =>
  new Date(DAY_START + minute * MINUTE).toISOString();
const ms = (minute: number) => DAY_START + minute * MINUTE;

const matter = (id: string, name: string) =>
  ({
    id,
    name,
    reference: null,
    color: null,
    clientName: null,
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  }) satisfies DesktopTimeEntryMatterCandidate;
const LEASE = matter("lease", "Beta lease");
const SERVICES = matter("services", "Service agreement");

type SegmentOptions = {
  from: number;
  to: number;
  app?: string;
  title?: string;
  matterId?: string;
};
const segment = ({
  from,
  to,
  app = "editor",
  title,
  matterId,
}: SegmentOptions): ActivitySegment => ({
  appIdentifier: `com.example.${app}`,
  appName: app === "browser" ? "Example Browser" : "Example Editor",
  start: at(from),
  end: at(to),
  matterId: matterId ?? null,
  windowTitle: title ?? null,
});

const day = (
  segments: ActivitySegment[],
  draftedEntries: { start: string; end: string; entryId: string }[] = [],
) =>
  matchDay({
    segments: timedSegments(segments),
    candidates: [LEASE, SERVICES],
    captureDetails: true,
    manualAssignments: [],
    draftedEntries,
  });

describe("activity blocks", () => {
  test("runs of short segments merge into one mixed block and no time is lost", () => {
    const { segments } = day([
      segment({ from: 0, to: 30 }),
      segment({ from: 30, to: 32, app: "browser" }),
      segment({ from: 32, to: 33 }),
      segment({ from: 33, to: 35, app: "browser" }),
      segment({ from: 35, to: 60, matterId: "lease" }),
    ]);
    for (const granularity of [15, 30, 60] as const) {
      const blocks = activityBlocks(segments, granularity);
      const covered = blocks.reduce(
        (sum, block) => sum + block.endMs - block.startMs,
        0,
      );
      expect(covered).toBe(60 * MINUTE);
      for (const block of blocks) {
        if (block.type === "single") {
          expect(block.endMs - block.startMs).toBeGreaterThanOrEqual(
            Math.min(
              shortSegmentThresholdMs(granularity),
              block.segment.endMs - block.segment.startMs,
            ),
          );
        }
      }
    }
    const mixed = activityBlocks(segments, 15).filter(
      (block) => block.type === "mixed",
    );
    expect(mixed).toHaveLength(1);
    expect(mixed.at(0)).toMatchObject({
      startMs: ms(30),
      endMs: ms(35),
      apps: [
        { identifier: "com.example.browser", durationMs: 4 * MINUTE },
        { identifier: "com.example.editor", durationMs: MINUTE },
      ],
    });
  });

  test("a block's details list its apps longest first with their longest title", () => {
    const { segments } = day([
      segment({ from: 0, to: 4, title: "Lease draft.docx" }),
      segment({ from: 4, to: 7, app: "browser", title: "Court calendar" }),
      segment({ from: 7, to: 9, title: "Engagement letter.docx" }),
      segment({ from: 9, to: 10, app: "browser" }),
      segment({ from: 10, to: 13, title: "Engagement letter.docx" }),
    ]);
    const details = blockDetails(segments, segmentTitles(segments));
    expect(details).toEqual({
      hiddenCount: 0,
      rows: [
        {
          durationMs: 9 * MINUTE,
          identifier: "com.example.editor",
          name: "Example Editor",
          title: "Engagement letter.docx",
        },
        {
          durationMs: 4 * MINUTE,
          identifier: "com.example.browser",
          name: "Example Browser",
          title: "Court calendar",
        },
      ],
    });
  });

  test("a block's details stop at the app limit, count the rest and lose no time", () => {
    const appCount = BLOCK_DETAIL_APP_LIMIT + 3;
    const { segments } = day(
      Array.from({ length: appCount }, (_, index) =>
        segment({
          from: index * 2,
          to: index * 2 + 2,
          app: `app-${String(index)}`,
        }),
      ),
    );
    const details = blockDetails(segments, segmentTitles(segments));
    expect(details.rows).toHaveLength(BLOCK_DETAIL_APP_LIMIT);
    expect(details.hiddenCount).toBe(appCount - BLOCK_DETAIL_APP_LIMIT);
    expect(
      details.rows.reduce((sum, row) => sum + row.durationMs, 0) +
        details.hiddenCount * 2 * MINUTE,
    ).toBe(appCount * 2 * MINUTE);
  });

  test("a segment one label line tall stays its own block at every grid", () => {
    for (const granularity of [15, 30, 60] as const) {
      const threshold = shortSegmentThresholdMs(granularity);
      expect(threshold).toBeLessThan(granularity * MINUTE);
      const { segments } = day([
        segment({ from: 0, to: 30 }),
        segment({
          from: 30,
          to: 30 + Math.ceil(threshold / MINUTE),
          app: "browser",
        }),
        segment({ from: 30 + Math.ceil(threshold / MINUTE), to: 90 }),
      ]);
      expect(
        activityBlocks(segments, granularity).map(({ type }) => type),
      ).toEqual(["single", "single", "single"]);
    }
  });

  test("titles lose the app suffix and the context the app's titles share", () => {
    const { segments } = day([
      segment({
        from: 0,
        to: 10,
        app: "browser",
        title: "Inbox · mail.example - Example Browser",
      }),
      segment({
        from: 10,
        to: 20,
        app: "browser",
        title: "Draft · mail.example - Example Browser",
      }),
      segment({ from: 20, to: 30, title: "Example Editor" }),
    ]);
    const titleOf = segmentTitles(segments);
    expect(segments.map(titleOf)).toEqual(["Inbox", "Draft", null]);
  });
});

describe("calendar hours", () => {
  const options = { date: "2026-10-09", timeZone: "UTC" };
  test("the working day stays visible and grows to whole hours around activity", () => {
    expect(calendarHours({ ...options, instants: [] })).toEqual({
      startHour: 8,
      endHour: 18,
    });
    expect(
      calendarHours({
        ...options,
        instants: [Date.UTC(2026, 9, 9, 6, 40), Date.UTC(2026, 9, 9, 19, 5)],
      }),
    ).toEqual({ startHour: 6, endHour: 20 });
    expect(
      calendarHours({ ...options, instants: [Date.UTC(2026, 9, 9, 19, 0)] }),
    ).toEqual({ startHour: 8, endHour: 19 });
  });

  test("instants on neighbouring days stretch the view to that edge", () => {
    expect(
      calendarHours({
        ...options,
        instants: [Date.UTC(2026, 9, 8, 23, 30), Date.UTC(2026, 9, 10, 0, 30)],
      }),
    ).toEqual({ startHour: 0, endHour: 24 });
  });
});

describe("suggestions", () => {
  const fixture = () =>
    day([
      segment({
        from: 0,
        to: 20,
        matterId: "services",
        title: "Agreement.docx",
      }),
      segment({
        from: 22,
        to: 40,
        matterId: "services",
        title: "Agreement.docx",
      }),
      segment({ from: 60, to: 90, matterId: "lease", title: "Lease review" }),
      segment({ from: 90, to: 100 }),
    ]);

  test("matched groups become suggestions in day order and unmatched time does not", () => {
    const suggestions = matchedSuggestions(fixture().groups, new Set());
    expect(suggestions.map(({ id }) => id)).toEqual(["services", "lease"]);
    expect(suggestions.at(0)?.runs).toEqual([
      { startMs: ms(0), endMs: ms(40) },
    ]);
    expect(
      matchedSuggestions(fixture().groups, new Set(["services"])).map(
        ({ id }) => id,
      ),
    ).toEqual(["lease"]);
  });

  test("a long idle gap splits a suggestion into separate blocks", () => {
    expect(
      contiguousRuns([
        { startMs: ms(0), endMs: ms(10) },
        { startMs: ms(15), endMs: ms(20) },
        { startMs: ms(26), endMs: ms(30) },
      ]),
    ).toEqual([
      { startMs: ms(0), endMs: ms(20) },
      { startMs: ms(26), endMs: ms(30) },
    ]);
  });

  test("drafted time leaves its suggestion", () => {
    const drafted = day(
      [
        segment({ from: 0, to: 20, matterId: "services" }),
        segment({ from: 60, to: 90, matterId: "lease" }),
      ],
      [{ start: at(0), end: at(20), entryId: "entry-1" }],
    );
    expect(
      matchedSuggestions(drafted.groups, new Set()).map(({ id }) => id),
    ).toEqual(["lease"]);
    expect(
      draftedBlocks(
        [{ start: at(0), end: at(20), entryId: "entry-1" }],
        drafted.segments,
      ),
    ).toEqual([
      { startMs: ms(0), endMs: ms(20), entryId: "entry-1", matter: SERVICES },
    ]);
  });

  test("a selected range keeps only its undrafted time and starts with the matter that took most of it", () => {
    const { segments } = day(
      [
        segment({ from: 0, to: 20, matterId: "services" }),
        segment({ from: 20, to: 50, matterId: "lease" }),
        segment({ from: 50, to: 70 }),
      ],
      [{ start: at(40), end: at(50), entryId: "entry-1" }],
    );
    const manual = manualSuggestion(segments, {
      startMs: ms(10),
      endMs: ms(60),
    });
    expect(manual.type).toBe("manual");
    expect(manual.matter?.id).toBe("lease");
    expect(manual.durationMs).toBe(40 * MINUTE);
    expect(manual.roundedTenths).toBe(7);
    expect(
      manual.ranges.map(({ start, end }) => [
        Temporal.Instant.from(start).epochMilliseconds,
        Temporal.Instant.from(end).epochMilliseconds,
      ]),
    ).toEqual([
      [ms(10), ms(20)],
      [ms(20), ms(40)],
      [ms(50), ms(60)],
    ]);
    const empty = manualSuggestion(segments, {
      startMs: ms(200),
      endMs: ms(215),
    });
    expect(empty).toMatchObject({
      durationMs: 0,
      matter: null,
      ranges: [],
      roundedTenths: 0,
      startMs: ms(200),
      endMs: ms(215),
    });
  });

  test("triage moves to the next suggestion and wraps to the day's first", () => {
    const suggestions = matchedSuggestions(fixture().groups, new Set());
    const [services, lease] = suggestions;
    if (!services || !lease) {
      throw new TypeError("The fixture must produce two suggestions");
    }
    expect(
      nextSuggestion(suggestions, {
        afterMs: services.startMs,
        excludeId: services.id,
      })?.id,
    ).toBe("lease");
    expect(
      nextSuggestion(suggestions, {
        afterMs: lease.startMs,
        excludeId: lease.id,
      })?.id,
    ).toBe("services");
    expect(
      nextSuggestion([services], {
        afterMs: services.startMs,
        excludeId: services.id,
      }),
    ).toBeNull();
  });
});

describe("suggestion evidence", () => {
  test("stella AI receives at most the limit of distinct titles, longest-used first", () => {
    const segments = Array.from(
      { length: NARRATIVE_TITLE_LIMIT + 10 },
      (_, index) =>
        segment({
          from: index * 2,
          to: index * 2 + 1 + (index === 7 ? 1 : 0),
          matterId: "lease",
          title: `Lease draft ${String(index)}`,
        }),
    );
    const [suggestion] = matchedSuggestions(day(segments).groups, new Set());
    if (!suggestion) {
      throw new TypeError("The fixture must produce a suggestion");
    }
    const titles = narrativeTitles(suggestion);
    expect(titles).toHaveLength(NARRATIVE_TITLE_LIMIT);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.at(0)).toBe("Lease draft 7");
  });

  test("title and app rows share the suggestion's time", () => {
    const [suggestion] = matchedSuggestions(
      day([
        segment({ from: 0, to: 30, matterId: "lease", title: "Lease draft" }),
        segment({
          from: 30,
          to: 40,
          app: "browser",
          matterId: "lease",
          title: "Land registry",
        }),
      ]).groups,
      new Set(),
    );
    if (!suggestion) {
      throw new TypeError("The fixture must produce a suggestion");
    }
    for (const rows of [titleRows(suggestion), appRows(suggestion)]) {
      const shares = rows.map(({ share }) => share);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
      expect(shares).toEqual([0.75, 0.25]);
    }
    expect(titleRows(suggestion).map(({ label }) => label)).toEqual([
      "Lease draft",
      "Land registry",
    ]);
  });
});
