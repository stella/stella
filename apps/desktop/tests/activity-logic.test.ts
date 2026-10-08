import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import contract from "../fixtures/activity-contract.json" with { type: "json" };
import {
  BLOCK_GAP_MS,
  MIN_PROPOSED_BLOCK_MS,
  documentName,
  appTotals,
  proposeBlocks,
  roundedTenthsOfHour,
  shiftDate,
  timedSegments,
  topAppNames,
  totalDurationMs,
} from "../src/activity/activity-logic";
import {
  ACTIVITY_CHANGED_EVENT,
  ACTIVITY_DETAILS_ACCESS,
  MAX_ACTIVITY_METADATA_BYTES,
  ACTIVITY_RECORDING_STATUSES,
  ACTIVITY_RETENTIONS,
  isActivityDaySnapshot,
} from "../src/activity/activity-types";

const MINUTE = 60_000;
const BASE_INSTANT = Temporal.Instant.from("2026-03-10T08:00:00Z");
const BASE = BASE_INSTANT.epochMilliseconds;

const at = (minute: number) => BASE_INSTANT.add({ minutes: minute }).toString();

const segment = (app: string, startMinute: number, endMinute: number) => ({
  appIdentifier: app,
  appName: app.toUpperCase(),
  end: at(endMinute),
  start: at(startMinute),
});

describe("activity contract", () => {
  test("the frontend lists the values the native side serializes", () => {
    expect(contract.retentions).toEqual([...ACTIVITY_RETENTIONS]);
    expect(contract.recordingStatuses).toEqual([
      ...ACTIVITY_RECORDING_STATUSES,
    ]);
    expect(contract.detailsAccess).toEqual([...ACTIVITY_DETAILS_ACCESS]);
    expect(contract.maxMetadataBytes).toBe(MAX_ACTIVITY_METADATA_BYTES);
    expect(contract.changedEvent).toBe(ACTIVITY_CHANGED_EVENT);
  });

  test("a snapshot is validated before use", () => {
    const snapshot = {
      date: "2026-03-10",
      draftedEntries: [],
      timeBillingEnabled: false,
      earliestDate: "2026-02-09",
      excludedApps: [{ identifier: "com.example.app", name: "App" }],
      otherAccountHistoryDays: 0,
      captureDetails: false,
      appNameOnlyApps: [],
      browserApps: [],
      browserTitleApps: [],
      detailsAccess: "disabled",
      persistence: "encrypted",
      recordingStatus: "recording",
      retention: "month",
      segments: [segment("word", 0, 5)],
      today: "2026-03-10",
      unreadable: false,
    };
    expect(isActivityDaySnapshot(snapshot)).toBe(true);
    for (const days of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "2",
      undefined,
    ]) {
      expect(
        isActivityDaySnapshot({ ...snapshot, otherAccountHistoryDays: days }),
      ).toBe(false);
    }
    expect(isActivityDaySnapshot({ ...snapshot, captureDetails: "yes" })).toBe(
      false,
    );
    expect(
      isActivityDaySnapshot({ ...snapshot, detailsAccess: "unknown" }),
    ).toBe(false);
    for (const invalid of [
      "a".repeat(MAX_ACTIVITY_METADATA_BYTES + 1),
      "é".repeat(MAX_ACTIVITY_METADATA_BYTES / 2 + 1),
      "line\nfeed",
      "null\u0000byte",
      123,
    ]) {
      for (const field of ["windowTitle", "document"]) {
        expect(
          isActivityDaySnapshot({
            ...snapshot,
            segments: [{ ...segment("word", 0, 5), [field]: invalid }],
          }),
        ).toBe(false);
      }
    }
    expect(
      isActivityDaySnapshot({
        ...snapshot,
        segments: [
          {
            ...segment("word", 0, 5),
            windowTitle: "é".repeat(MAX_ACTIVITY_METADATA_BYTES / 2),
            document: null,
          },
        ],
      }),
    ).toBe(true);
    expect(isActivityDaySnapshot({ ...snapshot, retention: "year" })).toBe(
      false,
    );
    expect(
      isActivityDaySnapshot({ ...snapshot, segments: [{ appName: "x" }] }),
    ).toBe(false);
  });
});

describe("activity day logic", () => {
  test("segments are parsed, ordered and empty ones dropped", () => {
    const segments = timedSegments([
      segment("mail", 30, 40),
      segment("word", 0, 10),
      segment("empty", 50, 50),
    ]);
    expect(segments.map((item) => item.appIdentifier)).toEqual([
      "word",
      "mail",
    ]);
    expect(totalDurationMs(segments)).toBe(20 * MINUTE);
  });

  test("app totals add up per app, longest first", () => {
    const totals = appTotals(
      timedSegments([
        segment("word", 0, 10),
        segment("mail", 10, 35),
        segment("word", 35, 40),
      ]),
    );
    expect(totals).toEqual([
      { durationMs: 25 * MINUTE, identifier: "mail", name: "MAIL" },
      { durationMs: 15 * MINUTE, identifier: "word", name: "WORD" },
    ]);
  });

  test("blocks merge across gaps shorter than ten minutes", () => {
    const blocks = proposeBlocks(
      timedSegments([
        segment("word", 0, 20),
        segment("mail", 29, 40),
        // Exactly ten minutes after the previous end: a new block.
        segment("word", 50, 61),
      ]),
    );
    expect(BLOCK_GAP_MS).toBe(10 * MINUTE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startMs).toBe(BASE);
    expect(blocks[0]?.endMs).toBe(BASE + 40 * MINUTE);
    // 40 minutes round up to 42: 0.7 h.
    expect(blocks[0]?.roundedTenths).toBe(7);
    expect(blocks[1]?.roundedTenths).toBe(2);
    expect(blocks[0] && topAppNames(blocks[0])).toEqual(["WORD", "MAIL"]);
  });

  test("blocks under three minutes stay in raw activity without becoming proposals", () => {
    expect(MIN_PROPOSED_BLOCK_MS).toBe(180_000);
    for (const seconds of [179, 180, 181]) {
      const segments = timedSegments([
        {
          appIdentifier: "word",
          appName: "WORD",
          start: BASE_INSTANT.toString(),
          end: BASE_INSTANT.add({ seconds }).toString(),
        },
      ]);
      expect(segments).toHaveLength(1);
      expect(totalDurationMs(segments)).toBe(seconds * 1000);
      const blocks = proposeBlocks(segments);
      expect(blocks).toHaveLength(seconds < 180 ? 0 : 1);
      if (seconds >= 180) {
        expect(blocks.at(0)?.roundedTenths).toBe(1);
      }
    }
  });

  test("blocks group consecutive activity by the full document path across apps", () => {
    const first = "/one/memo.docx";
    const second = "/two/memo.docx";
    const blocks = proposeBlocks(
      timedSegments([
        {
          ...segment("word", 0, 4),
          document: first,
          windowTitle: "First title",
        },
        {
          ...segment("pdf", 4, 7),
          document: first,
          windowTitle: "Second title",
        },
        {
          ...segment("word", 7, 11),
          document: second,
          windowTitle: "Other document",
        },
        {
          ...segment("word", 11, 15),
          document: first,
          windowTitle: "First title",
        },
      ]),
    );
    expect(blocks.map(({ document }) => document)).toEqual([
      first,
      second,
      first,
    ]);
    expect(blocks.at(0)?.windowTitles).toEqual(["First title", "Second title"]);
    expect(blocks.at(0)?.apps.map(({ name }) => name)).toEqual(["WORD", "PDF"]);
    expect(blocks.at(0)?.endMs).toBe(BASE + 7 * MINUTE);
  });

  test("title changes alone retain one block with unique titles", () => {
    const blocks = proposeBlocks(
      timedSegments([
        { ...segment("word", 0, 4), windowTitle: "A" },
        { ...segment("word", 4, 7), windowTitle: "B" },
        { ...segment("word", 7, 11), windowTitle: "A" },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks.at(0)?.document).toBeNull();
    expect(blocks.at(0)?.windowTitles).toEqual(["A", "B"]);
  });

  test("legacy app-only segments still parse and path display uses only the file name", () => {
    const parsed = timedSegments([segment("word", 0, 5)]);
    expect(parsed.at(0)?.document).toBeNull();
    expect(parsed.at(0)?.windowTitle).toBeNull();
    expect(documentName("/private/folder/memo.docx")).toBe("memo.docx");
    expect(documentName("C:\\private\\folder\\memo.docx")).toBe("memo.docx");
  });

  test("durations round up to whole six-minute increments", () => {
    expect(roundedTenthsOfHour(0)).toBe(0);
    expect(roundedTenthsOfHour(1)).toBe(1);
    expect(roundedTenthsOfHour(6 * MINUTE)).toBe(1);
    expect(roundedTenthsOfHour(6 * MINUTE + 1)).toBe(2);
    for (let minutes = 1; minutes <= 600; minutes += 1) {
      const tenths = roundedTenthsOfHour(minutes * MINUTE);
      expect(tenths * 6).toBeGreaterThanOrEqual(minutes);
      expect((tenths - 1) * 6).toBeLessThan(minutes);
    }
  });

  test("calendar dates shift across month and year boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
  });
});
