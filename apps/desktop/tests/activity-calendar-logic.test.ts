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
  TOPIC_BRIDGE_GAP_MS,
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
  test("quick switching between apps with no matter is one block, and no segment is lost", () => {
    // Ten-second pauses between switches, as the recorder leaves them.
    const pause = 10_000;
    const switches = Array.from({ length: 12 }, (_, index) =>
      segment({
        from: index * 2,
        to: index * 2 + 2 - pause / MINUTE,
        app: index % 2 === 0 ? "editor" : "browser",
        title: `Window ${String(index % 3)}`,
      }),
    );
    const { segments } = day(switches);
    for (const granularity of [15, 30, 60] as const) {
      const blocks = activityBlocks(segments, granularity);
      expect(blocks).toHaveLength(1);
      expect(blocks.flatMap(({ sources }) => sources)).toHaveLength(
        segments.length,
      );
      expect(blocks.at(0)).toMatchObject({
        matter: null,
        startMs: ms(0),
        apps: [
          { identifier: "com.example.editor" },
          { identifier: "com.example.browser" },
        ],
      });
    }
  });

  test("a matter's time is one block through other apps and short pauses", () => {
    const { segments } = day([
      segment({ from: 0, to: 12, matterId: "lease", title: "Lease.docx" }),
      // A quick look at mail, then back after a pause under two minutes.
      segment({ from: 12, to: 13, app: "browser", title: "Inbox" }),
      segment({ from: 14.5, to: 30, matterId: "lease", title: "Lease.docx" }),
      segment({
        from: 30,
        to: 41,
        app: "browser",
        matterId: "lease",
        title: "Land registry",
      }),
    ]);
    const blocks = activityBlocks(segments, 30);
    expect(blocks).toHaveLength(1);
    expect(blocks.at(0)).toMatchObject({
      matter: { id: "lease" },
      startMs: ms(0),
      endMs: ms(41),
      title: "Lease.docx",
    });
    expect(blocks.at(0)?.apps.map(({ identifier }) => identifier)).toEqual([
      "com.example.editor",
      "com.example.browser",
    ]);
  });

  test("a pause longer than the bridge splits a topic, and a short matter stretch keeps its block", () => {
    const resume = 40 + TOPIC_BRIDGE_GAP_MS / MINUTE + 1;
    const { segments } = day([
      segment({ from: 0, to: 20, matterId: "lease" }),
      // Three minutes on another matter between two stretches of the lease.
      segment({ from: 20, to: 23, matterId: "services" }),
      segment({ from: 23, to: 40, matterId: "lease" }),
      // Back on the lease after a pause longer than the bridge.
      segment({ from: resume, to: 70, matterId: "lease" }),
    ]);
    expect(
      activityBlocks(segments, 60).map((block) => [
        block.matter?.id,
        block.startMs,
        block.endMs,
      ]),
    ).toEqual([
      ["lease", ms(0), ms(20)],
      ["services", ms(20), ms(23)],
      ["lease", ms(23), ms(40)],
      ["lease", ms(resume), ms(70)],
    ]);
  });

  test("time no matter claimed splits by the document it was on", () => {
    const { segments } = day([
      segment({ from: 0, to: 25, title: "Board minutes.docx" }),
      segment({ from: 25, to: 26, app: "browser", title: "Inbox" }),
      segment({ from: 26, to: 50, title: "Engagement letter.docx" }),
    ]);
    const blocks = activityBlocks(segments, 30);
    expect(blocks.map(({ title }) => title)).toEqual([
      "Board minutes.docx",
      "Engagement letter.docx",
    ]);
    // The minute in the inbox joins a neighbour instead of drawing a sliver.
    expect(blocks.flatMap(({ sources }) => sources)).toHaveLength(3);
  });

  test("blocks keep every segment once, and only an isolated stretch with no matter is shorter than a label", () => {
    // Deterministic pseudo-random days: segments of 10 s to 25 min, pauses of
    // 0 to 4 min, on two matters or none, three apps and four titles.
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const apps = ["editor", "browser", "mail"] as const;
    const matterFor = (pick: number) => {
      if (pick < 0.3) {
        return "lease";
      }
      return pick < 0.45 ? "services" : undefined;
    };
    for (let round = 0; round < 40; round += 1) {
      const generated: ActivitySegment[] = [];
      let minute = 0;
      for (let index = 0; index < 60; index += 1) {
        minute += random() < 0.5 ? 0 : random() * 4;
        const length = 1 / 6 + random() * 25 * (random() < 0.7 ? 0.1 : 1);
        const pick = random();
        generated.push(
          segment({
            from: minute,
            to: minute + length,
            app: apps[Math.floor(random() * apps.length)],
            title: `Title ${String(Math.floor(random() * 4))}`,
            matterId: matterFor(pick),
          }),
        );
        minute += length;
      }
      const { segments } = day(generated);
      for (const granularity of [15, 30, 60] as const) {
        const blocks = activityBlocks(segments, granularity);
        const placed = blocks.flatMap(({ sources }) => sources);
        expect(placed).toHaveLength(segments.length);
        expect(new Set(placed).size).toBe(segments.length);
        const threshold = shortSegmentThresholdMs(granularity);
        for (const [index, block] of blocks.entries()) {
          for (const source of block.sources) {
            expect(source.startMs).toBeGreaterThanOrEqual(block.startMs);
            expect(source.endMs).toBeLessThanOrEqual(block.endMs);
            if (source.matter !== null) {
              // A matter's own time is never drawn under another matter.
              expect(block.matter?.id).toBe(source.matter.id);
            }
          }
          if (
            block.matter === null &&
            block.endMs - block.startMs < threshold
          ) {
            const before = blocks[index - 1];
            const after = blocks[index + 1];
            expect(
              before === undefined ||
                block.startMs - before.endMs > TOPIC_BRIDGE_GAP_MS,
            ).toBe(true);
            expect(
              after === undefined ||
                after.startMs - block.endMs > TOPIC_BRIDGE_GAP_MS,
            ).toBe(true);
          }
        }
      }
    }
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

  test("a stretch one label line tall stays its own block at every grid", () => {
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
        activityBlocks(segments, granularity).map(({ apps }) =>
          apps.map(({ identifier }) => identifier),
        ),
      ).toEqual([
        ["com.example.editor"],
        ["com.example.browser"],
        ["com.example.editor"],
      ]);
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
