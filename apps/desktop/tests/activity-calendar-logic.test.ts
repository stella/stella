import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
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
  nextSuggestion,
  segmentTitles,
  shortSegmentThresholdMs,
  suggestionPieces,
  suggestionSummary,
  titleRows,
  TOPIC_BRIDGE_GAP_MS,
  undraftedParts,
  wallClockTime,
  withMovedEdge,
} from "../src/activity/activity-calendar-logic";
import { timedSegments } from "../src/activity/activity-logic";
import type { ActivitySegment } from "../src/activity/activity-types";
import { matchDay } from "../src/activity/day-review-logic";

const MINUTE = 60_000;
const DAY_START = Date.UTC(2026, 9, 9, 8, 0);
const at = (minute: number) =>
  new Date(DAY_START + minute * MINUTE).toISOString();
const ms = (minute: number) => DAY_START + minute * MINUTE;
const instantPairs = (ranges: readonly { start: string; end: string }[]) =>
  ranges.map(({ start, end }) => [
    Temporal.Instant.from(start).epochMilliseconds,
    Temporal.Instant.from(end).epochMilliseconds,
  ]);

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
  app?: string | undefined;
  title?: string | undefined;
  matterId?: string | undefined;
  call?: boolean | undefined;
};
const APP_NAMES: Record<string, string> = {
  browser: "Example Browser",
  editor: "Example Editor",
  meetings: "Example Meetings",
};
const segment = ({
  from,
  to,
  app = "editor",
  title,
  matterId,
  call,
}: SegmentOptions): ActivitySegment => ({
  appIdentifier: `com.example.${app}`,
  appName: APP_NAMES[app] ?? app,
  ...(call === undefined ? {} : { call }),
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
      expect(blocks.at(0)).toMatchObject({ matter: null, startMs: ms(0) });
      // Both apps had the same time, so their order is not part of this.
      expect(
        blocks
          .at(0)
          ?.apps.map(({ identifier }) => identifier)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(["com.example.browser", "com.example.editor"]);
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

  test("a quick look at another app between two short pauses keeps a matter in one block", () => {
    const { segments } = day([
      segment({ from: 0, to: 10, matterId: "lease" }),
      // A minute's pause, a minute in the inbox, a minute and a half's pause.
      segment({ from: 11, to: 12, app: "browser", title: "Inbox" }),
      segment({ from: 13.5, to: 25, matterId: "lease" }),
    ]);
    expect(
      activityBlocks(segments, 30).map((block) => [
        block.matter?.id,
        block.startMs,
        block.endMs,
        block.sources.length,
      ]),
    ).toEqual([["lease", ms(0), ms(25), 3]]);
  });

  test("a pause longer than the bridge on either side of a quick look splits the matter", () => {
    const { segments } = day([
      segment({ from: 0, to: 10, matterId: "lease" }),
      segment({ from: 13, to: 14, app: "browser", title: "Inbox" }),
      segment({ from: 15, to: 25, matterId: "lease" }),
    ]);
    expect(
      activityBlocks(segments, 30).map((block) => [
        block.matter?.id,
        block.startMs,
        block.endMs,
      ]),
    ).toEqual([
      ["lease", ms(0), ms(10)],
      ["lease", ms(13), ms(25)],
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
            // A brief block left alone is a pause from every block, and more
            // than a label line from every other brief block with no matter.
            const apart = (other: (typeof blocks)[number] | undefined) => {
              if (other === undefined) {
                return true;
              }
              const gapMs =
                other.startMs > block.startMs
                  ? other.startMs - block.endMs
                  : block.startMs - other.endMs;
              const otherBrief =
                other.matter === null &&
                other.endMs - other.startMs < threshold;
              return gapMs > (otherBrief ? threshold : TOPIC_BRIDGE_GAP_MS);
            };
            expect(apart(before)).toBe(true);
            expect(apart(after)).toBe(true);
          }
          // Drawn at least a label line tall, never over the next block.
          const next = blocks[index + 1];
          expect(block.drawnEndMs).toBeGreaterThanOrEqual(block.endMs);
          expect(next === undefined || block.drawnEndMs <= next.startMs).toBe(
            true,
          );
          expect(
            block.drawnEndMs - block.startMs >= threshold ||
              block.drawnEndMs === next?.startMs,
          ).toBe(true);
        }
      }
    }
  });

  test("brief stretches a few minutes apart are one block, drawn a label line tall when alone", () => {
    const { segments } = day([
      segment({ from: 0, to: 1, title: "Inbox" }),
      segment({ from: 4, to: 5, app: "browser", title: "News" }),
      segment({ from: 9, to: 10, title: "Calendar" }),
      // Alone: more than a label line from anything.
      segment({ from: 40, to: 41, app: "browser", title: "Weather" }),
    ]);
    const threshold = shortSegmentThresholdMs(15);
    expect(threshold).toBeGreaterThan(9 * MINUTE);
    expect(
      activityBlocks(segments, 15).map((block) => [
        block.startMs,
        block.endMs,
        block.drawnEndMs,
        block.sources.length,
      ]),
    ).toEqual([
      [ms(0), ms(10), ms(0) + threshold, 3],
      [ms(40), ms(41), ms(40) + threshold, 1],
    ]);
  });

  test("a block takes the topic holding half its time, and none when nothing does", () => {
    const { segments } = day([
      // Mostly one document: its topic.
      segment({ from: 0, to: 6, title: "Board minutes.docx" }),
      segment({ from: 6, to: 8, app: "browser", title: "Court calendar" }),
      segment({ from: 8, to: 30, title: "Board minutes.docx" }),
      // Quick switching between four unrelated windows: no topic.
      segment({ from: 60, to: 62, title: "Inbox" }),
      segment({ from: 62, to: 64, app: "browser", title: "News" }),
      segment({ from: 64, to: 66, title: "Calendar" }),
      segment({ from: 66, to: 68, app: "browser", title: "Weather" }),
      // A matter's time: the matter.
      segment({ from: 90, to: 120, matterId: "lease" }),
    ]);
    expect(
      activityBlocks(segments, 15).map(({ startMs, topic }) => [
        startMs,
        topic,
      ]),
    ).toEqual([
      [ms(0), "title:board minutes.docx"],
      [ms(60), null],
      [ms(90), "matter:lease"],
    ]);
  });

  test("a block is named by the topic that sets its colour, never by time it took in", () => {
    const { segments } = day([
      // Brief stretches joined into one: mostly an untitled call, with a
      // titled document in between.
      segment({ from: 0, to: 3, app: "meetings", call: true }),
      segment({ from: 3, to: 5, title: "Draft.docx" }),
      segment({ from: 5, to: 8, app: "meetings", call: true }),
      // Quick switching between four unrelated windows: no topic, no name.
      segment({ from: 60, to: 62, title: "Inbox" }),
      segment({ from: 62, to: 64, app: "browser", title: "News" }),
      segment({ from: 64, to: 66, title: "Calendar" }),
      segment({ from: 66, to: 68, app: "browser", title: "Weather" }),
    ]);
    expect(
      activityBlocks(segments, 15).map(
        ({ topic, title, topicApp, sources }) => ({
          topic,
          title,
          topicApp,
          sources: sources.length,
        }),
      ),
    ).toEqual([
      {
        topic: "call:com.example.meetings",
        title: null,
        topicApp: {
          appIdentifier: "com.example.meetings",
          appName: "Example Meetings",
          call: true,
        },
        sources: 3,
      },
      { topic: null, title: null, topicApp: null, sources: 4 },
    ]);
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
    ).toEqual({
      startHour: 8,
      endHour: 19,
    });
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

  test("a selected range is the entry to the minute, whether or not activity was recorded in it", () => {
    const { segments } = day([
      segment({ from: 0, to: 8, matterId: "lease" }),
      segment({ from: 20, to: 40 }),
    ]);
    // 08:03 to 08:15: twelve minutes, five of them recorded.
    const manual = manualSuggestion({
      drafted: [],
      id: "manual:picked",
      range: { startMs: ms(3), endMs: ms(15) },
      segments,
    });
    expect(manual).toMatchObject({
      durationMs: 12 * MINUTE,
      endMs: ms(15),
      id: "manual:picked",
      matter: { id: "lease" },
      roundedTenths: 2,
      startMs: ms(3),
      type: "manual",
    });
    expect(instantPairs(manual.ranges)).toEqual([[ms(3), ms(15)]]);
    // The recorded part is the evidence, never more than the range holds.
    expect(
      manual.segments.map(({ startMs, endMs }) => [startMs, endMs]),
    ).toEqual([[ms(3), ms(8)]]);
    // Ten minutes bill as two tenths, yet the entry still covers ten minutes.
    const tenMinutes = manualSuggestion({
      drafted: [],
      id: "manual:ten",
      range: { startMs: ms(5), endMs: ms(15) },
      segments,
    });
    expect(tenMinutes.durationMs).toBe(10 * MINUTE);
    expect(tenMinutes.roundedTenths).toBe(2);
    expect(instantPairs(tenMinutes.ranges)).toEqual([[ms(5), ms(15)]]);

    const unrecorded = manualSuggestion({
      drafted: [],
      id: "manual:call",
      range: { startMs: ms(200), endMs: ms(215) },
      segments,
    });
    expect(unrecorded).toMatchObject({
      durationMs: 15 * MINUTE,
      matter: null,
      roundedTenths: 3,
      segments: [],
      startMs: ms(200),
      endMs: ms(215),
    });
    expect(instantPairs(unrecorded.ranges)).toEqual([[ms(200), ms(215)]]);
  });

  test("a selected range leaves out drafted time and starts with the matter that took most of the rest", () => {
    const drafted = [{ start: at(40), end: at(50), entryId: "entry-1" }];
    const { segments } = day(
      [
        segment({ from: 0, to: 20, matterId: "services" }),
        segment({ from: 20, to: 50, matterId: "lease" }),
        segment({ from: 50, to: 70 }),
      ],
      drafted,
    );
    const manual = manualSuggestion({
      drafted,
      id: "manual:around",
      range: { startMs: ms(10), endMs: ms(60) },
      segments,
    });
    expect(manual.matter?.id).toBe("lease");
    expect(manual.durationMs).toBe(40 * MINUTE);
    expect(manual.roundedTenths).toBe(7);
    expect(instantPairs(manual.ranges)).toEqual([
      [ms(10), ms(40)],
      [ms(50), ms(60)],
    ]);
    // The card and the selection keep the range as the user set it.
    expect([manual.startMs, manual.endMs]).toEqual([ms(10), ms(60)]);

    const covered = manualSuggestion({
      drafted,
      id: "manual:covered",
      range: { startMs: ms(42), endMs: ms(48) },
      segments,
    });
    expect(covered).toMatchObject({
      durationMs: 0,
      ranges: [],
      roundedTenths: 0,
    });
  });

  test("a backwards range claims no time", () => {
    const manual = manualSuggestion({
      drafted: [],
      id: "manual:backwards",
      range: { startMs: ms(30), endMs: ms(20) },
      segments: day([segment({ from: 0, to: 60 })]).segments,
    });
    expect(manual).toMatchObject({
      durationMs: 0,
      endMs: ms(30),
      ranges: [],
      roundedTenths: 0,
      segments: [],
      startMs: ms(30),
    });
  });

  test(
    "undrafted parts cover the range exactly where nothing is drafted",
    () => {
      const span = fc
        .tuple(
          fc.integer({ min: 0, max: 120 }),
          fc.integer({ min: 0, max: 60 }),
        )
        .map(([from, length]) => ({
          startMs: ms(from),
          endMs: ms(from + length),
        }));
      assertProperty(
        "undrafted parts cover the range exactly where nothing is drafted",
        fc.property(
          span,
          fc.array(span, { maxLength: 6 }),
          (range, drafted) => {
            const parts = undraftedParts(range, drafted);
            const isDrafted = (minuteMs: number) =>
              drafted.some(
                ({ startMs, endMs }) => startMs <= minuteMs && minuteMs < endMs,
              );
            for (const [index, part] of parts.entries()) {
              expect(part.endMs).toBeGreaterThan(part.startMs);
              const next = parts.at(index + 1);
              if (next !== undefined) {
                // Parts are ordered and a drafted stretch separates them.
                expect(next.startMs).toBeGreaterThan(part.endMs);
              }
            }
            for (let minuteMs = ms(0); minuteMs < ms(180); minuteMs += MINUTE) {
              const inRange =
                range.startMs <= minuteMs && minuteMs < range.endMs;
              const inPart = parts.some(
                ({ startMs, endMs }) => startMs <= minuteMs && minuteMs < endMs,
              );
              expect(inPart).toBe(inRange && !isDrafted(minuteMs));
            }
          },
        ),
      );
    },
    propertyTestTimeout(5000),
  );

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

describe("a selected range's starting matter", () => {
  const select = (segments: ActivitySegment[], from: number, to: number) =>
    manualSuggestion({
      drafted: [],
      id: "manual:range",
      range: { startMs: ms(from), endMs: ms(to) },
      segments: day(segments).segments,
    });

  test("a matter holding a minority of the recorded time is not preselected", () => {
    // 42 minutes of mail no matter claimed, 18 of the lease draft.
    const manual = select(
      [
        segment({ from: 0, to: 42, app: "browser", title: "Training invite" }),
        segment({ from: 42, to: 60, matterId: "lease", title: "Lease.docx" }),
      ],
      0,
      60,
    );
    expect(manual).toMatchObject({
      matter: null,
      matterBasis: "mostlyUnmatched",
      type: "manual",
    });
    // The evidence still names the minority matter beside its own row.
    expect(
      titleRows(manual).map((row) => [row.label, row.matter?.id ?? null]),
    ).toEqual([
      ["Training invite", null],
      ["Lease.docx", "lease"],
    ]);
    expect(
      appRows(manual).map((row) => [row.label, row.matter?.id ?? null]),
    ).toEqual([
      ["Example Browser", null],
      ["Example Editor", "lease"],
    ]);
  });

  test("a matter holding at least half of the recorded time is preselected", () => {
    const half = select(
      [
        segment({ from: 0, to: 30, matterId: "lease" }),
        segment({ from: 30, to: 60, app: "browser" }),
      ],
      0,
      60,
    );
    expect(half).toMatchObject({ matter: { id: "lease" } });
    expect(half.matterBasis).toBe("majority");
    // Unrecorded time in the range does not count against the matter.
    const sparse = select(
      [
        segment({ from: 0, to: 12, matterId: "lease" }),
        segment({ from: 12, to: 20, app: "browser" }),
      ],
      0,
      60,
    );
    expect(sparse.matter?.id).toBe("lease");
  });

  test("time split between matters with no majority preselects none", () => {
    const manual = select(
      [
        segment({ from: 0, to: 25, matterId: "lease" }),
        segment({ from: 25, to: 45, matterId: "services" }),
        segment({ from: 45, to: 60, app: "browser" }),
      ],
      0,
      60,
    );
    expect(manual).toMatchObject({
      matter: null,
      matterBasis: "splitBetweenMatters",
    });
  });

  test("a range with nothing recorded preselects no matter", () => {
    const manual = select(
      [segment({ from: 0, to: 30, matterId: "lease" })],
      120,
      150,
    );
    expect(manual).toMatchObject({
      matter: null,
      matterBasis: "nothingRecorded",
      segments: [],
    });
  });

  test(
    "a range starts on a matter exactly when that matter holds at least half its recorded time",
    () => {
      const stretch = fc.record({
        length: fc.integer({ min: 1, max: 20 }),
        matterId: fc.constantFrom("lease", "services", undefined),
      });
      assertProperty(
        "a range starts on a matter exactly when that matter holds at least half its recorded time",
        fc.property(
          fc.array(stretch, { maxLength: 8 }),
          fc.integer({ min: 0, max: 80 }),
          fc.integer({ min: 0, max: 80 }),
          (stretches, from, length) => {
            let cursor = 0;
            const segments = stretches.map(({ length: minutes, matterId }) => {
              const recorded = segment({
                from: cursor,
                to: cursor + minutes,
                matterId,
              });
              cursor += minutes;
              return recorded;
            });
            const manual = select(segments, from, from + length);
            const recordedMs = manual.segments.reduce(
              (sum, { startMs, endMs }) => sum + endMs - startMs,
              0,
            );
            const matterMs = (id: string) =>
              manual.segments
                .filter((recorded) => recorded.matter?.id === id)
                .reduce((sum, { startMs, endMs }) => sum + endMs - startMs, 0);
            const majority = ["lease", "services"].some(
              (id) => recordedMs > 0 && matterMs(id) * 2 >= recordedMs,
            );
            expect(manual.matter !== null).toBe(majority);
            if (manual.matter !== null) {
              expect(matterMs(manual.matter.id) * 2).toBeGreaterThanOrEqual(
                recordedMs,
              );
            }
          },
        ),
      );
    },
    propertyTestTimeout(5000),
  );
});

describe("suggestion evidence", () => {
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

describe("suggestion pieces", () => {
  const onlySuggestion = (segments: ActivitySegment[]) => {
    const [suggestion] = matchedSuggestions(day(segments).groups, new Set());
    if (!suggestion) {
      throw new TypeError("The fixture must produce a suggestion");
    }
    return suggestion;
  };

  test("each piece counts its own recorded time, and the card's summary adds them up", () => {
    const suggestion = onlySuggestion([
      segment({ from: 0, to: 30, matterId: "lease", title: "Lease draft" }),
      // A two-minute pause keeps one piece but is not time worked.
      segment({ from: 32, to: 40, matterId: "lease", title: "Lease draft" }),
      segment({ from: 120, to: 188, matterId: "lease", title: "Annex" }),
    ]);
    const pieces = suggestionPieces(suggestion);
    expect(pieces).toEqual([
      { startMs: ms(0), endMs: ms(40), minutes: 38 },
      { startMs: ms(120), endMs: ms(188), minutes: 68 },
    ]);
    expect(suggestionSummary(suggestion)).toEqual({
      count: 2,
      minutes: 106,
      tenths: suggestion.roundedTenths,
      type: "pieces",
    });
  });

  test("a suggestion in one piece keeps its range in the summary", () => {
    const suggestion = onlySuggestion([
      segment({ from: 10, to: 55, matterId: "lease", title: "Lease draft" }),
    ]);
    expect(suggestionSummary(suggestion)).toEqual({
      endMs: ms(55),
      minutes: 45,
      startMs: ms(10),
      tenths: 8,
      type: "range",
    });
  });

  test("a selected range's pieces are the parts no entry covers, at full length", () => {
    const suggestion = manualSuggestion({
      drafted: [{ start: at(20), end: at(30) }],
      id: "manual:test",
      range: { startMs: ms(0), endMs: ms(60) },
      segments: [],
    });
    expect(suggestionPieces(suggestion).map(({ minutes }) => minutes)).toEqual([
      20, 30,
    ]);
    expect(suggestionSummary(suggestion)).toMatchObject({
      count: 2,
      minutes: 50,
      type: "pieces",
    });
  });

  test(
    "pieces round together: their minutes add up to the rounded total and each is within a minute of its time",
    () => {
      assertProperty(
        "pieces round together: their minutes add up to the rounded total and each is within a minute of its time",
        fc.property(
          // Seconds worked in each piece; pieces sit ten minutes apart, so
          // each is its own.
          fc.array(fc.integer({ min: 1, max: 90 * 60 }), {
            minLength: 1,
            maxLength: 8,
          }),
          (seconds) => {
            let from = 0;
            const segments = seconds.map((length) => {
              const piece = segment({
                from,
                to: from + length / 60,
                matterId: "lease",
                title: "Lease draft",
              });
              from += length / 60 + 10;
              return piece;
            });
            const pieces = suggestionPieces(onlySuggestion(segments));
            expect(pieces).toHaveLength(seconds.length);
            const totalSeconds = seconds.reduce((sum, value) => sum + value, 0);
            expect(pieces.reduce((sum, { minutes }) => sum + minutes, 0)).toBe(
              Math.round(totalSeconds / 60),
            );
            for (const [index, piece] of pieces.entries()) {
              expect(
                Math.abs(piece.minutes - (seconds[index] ?? 0) / 60),
              ).toBeLessThan(1);
            }
          },
        ),
      );
    },
    propertyTestTimeout(5000),
  );
});

describe("untitled time in the Titles tab", () => {
  test("an app's time without a title is its own row, so the tab adds up to the suggestion", () => {
    const [suggestion] = matchedSuggestions(
      day([
        segment({ from: 0, to: 30, matterId: "lease", title: "Lease draft" }),
        segment({ from: 30, to: 38, app: "browser", matterId: "lease" }),
        // A title that only repeats the app's name is no title.
        segment({
          from: 38,
          to: 40,
          app: "browser",
          matterId: "lease",
          title: "Example Browser",
        }),
      ]).groups,
      new Set(),
    );
    if (!suggestion) {
      throw new TypeError("The fixture must produce a suggestion");
    }
    const rows = titleRows(suggestion);
    expect(
      rows.map(({ appIdentifier, durationMs, label, type }) => ({
        appIdentifier,
        durationMs,
        label,
        type,
      })),
    ).toEqual([
      {
        appIdentifier: "com.example.editor",
        durationMs: 30 * MINUTE,
        label: "Lease draft",
        type: "named",
      },
      {
        appIdentifier: "com.example.browser",
        durationMs: 10 * MINUTE,
        label: "Example Browser",
        type: "untitled",
      },
    ]);
    expect(rows.reduce((sum, { share }) => sum + share, 0)).toBeCloseTo(1);
  });

  test("a fully titled suggestion has no untitled row", () => {
    const [suggestion] = matchedSuggestions(
      day([
        segment({ from: 0, to: 30, matterId: "lease", title: "Lease draft" }),
      ]).groups,
      new Set(),
    );
    expect(suggestion && titleRows(suggestion).map(({ type }) => type)).toEqual(
      ["named"],
    );
  });
});

describe("a selected range set to the minute", () => {
  const timeZone = "Europe/Prague";
  const date = "2026-10-09";
  const wall = (time: string) =>
    Temporal.PlainDate.from(date).toZonedDateTime({
      plainTime: Temporal.PlainTime.from(time),
      timeZone,
    }).epochMilliseconds;
  const range = { startMs: wall("10:00"), endMs: wall("10:30") };

  test("a new end sets the entry's length to the minute", () => {
    const moved = withMovedEdge({
      date,
      edge: "end",
      range: { startMs: wall("10:03"), endMs: wall("10:30") },
      time: { hour: 10, minute: 15 },
      timeZone,
    });
    expect(moved).toEqual({ startMs: wall("10:03"), endMs: wall("10:15") });
    const entry = manualSuggestion({
      drafted: [],
      id: "manual:edited",
      range: moved,
      segments: [],
    });
    expect(entry.durationMs).toBe(12 * MINUTE);
    expect(entry.roundedTenths * 6).toBe(12);
  });

  test("a new start moves the range and keeps its length", () => {
    expect(
      withMovedEdge({
        date,
        edge: "start",
        range,
        time: { hour: 10, minute: 3 },
        timeZone,
      }),
    ).toEqual({ startMs: wall("10:03"), endMs: wall("10:33") });
    // Late in the day the length gives way to the day's end.
    expect(
      withMovedEdge({
        date,
        edge: "start",
        range,
        time: { hour: 23, minute: 50 },
        timeZone,
      }),
    ).toEqual({
      startMs: wall("23:50"),
      endMs: Temporal.PlainDate.from("2026-10-10").toZonedDateTime({ timeZone })
        .epochMilliseconds,
    });
  });

  test("an end at midnight is the day's end, and an end before the start stays as set", () => {
    const midnight = withMovedEdge({
      date,
      edge: "end",
      range,
      time: { hour: 0, minute: 0 },
      timeZone,
    });
    expect(midnight.endMs - midnight.startMs).toBe(14 * 60 * MINUTE);
    expect(wallClockTime(midnight.endMs, timeZone)).toBe("00:00");
    const backwards = withMovedEdge({
      date,
      edge: "end",
      range,
      time: { hour: 9, minute: 45 },
      timeZone,
    });
    expect(backwards).toEqual({ startMs: wall("10:00"), endMs: wall("09:45") });
  });

  test("every minute of a daylight-saving day reads back as set, and a skipped one resolves forward", () => {
    // Prague skips 02:00 to 03:00 on this day.
    const springDate = "2026-03-29";
    const springDay = Temporal.PlainDate.from(springDate);
    const dayStart = springDay.toZonedDateTime({ timeZone }).epochMilliseconds;
    const springRange = { startMs: dayStart, endMs: dayStart + 30 * MINUTE };
    let skipped = 0;
    for (let minuteOfDay = 1; minuteOfDay < 24 * 60; minuteOfDay += 1) {
      const time = {
        hour: Math.floor(minuteOfDay / 60),
        minute: minuteOfDay % 60,
      };
      const set = Temporal.PlainTime.from(time).toString({
        smallestUnit: "minute",
      });
      const { endMs } = withMovedEdge({
        date: springDate,
        edge: "end",
        range: springRange,
        time,
        timeZone,
      });
      const read = wallClockTime(endMs, timeZone);
      if (time.hour === 2) {
        skipped += 1;
        expect(read).toBe(
          Temporal.PlainTime.from({ hour: 3, minute: time.minute }).toString({
            smallestUnit: "minute",
          }),
        );
        continue;
      }
      expect(read).toBe(set);
    }
    expect(skipped).toBe(60);
  });
});
