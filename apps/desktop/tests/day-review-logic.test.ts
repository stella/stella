import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type {
  DesktopMatterResolution,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { assertProperty } from "@stll/property-testing";

import { timedSegments, totalDurationMs } from "../src/activity/activity-logic";
import {
  cleanSharedContext,
  matchDay,
  recordedElsewhere,
  recordedMatterIds,
  unresolvedMatterIds,
  withoutAppSuffix,
} from "../src/activity/day-review-logic";
import type { DayEntriesRead } from "../src/activity/day-review-logic";
import { EMPTY_MATTER_LEARNING } from "../src/activity/matter-learning";

const ALPHA = {
  id: "a",
  name: "Alpha dispute",
  reference: "A-101",
  color: null,
  clientName: "Common client",
  signals: {
    lastWorkedAt: null,
    newlyAssignedAt: null,
    upcomingDeadline: null,
  },
} satisfies DesktopTimeEntryMatterCandidate;
const candidates = [
  ALPHA,
  {
    id: "b",
    name: "Beta dispute",
    reference: "B-202",
    color: null,
    clientName: "Common client",
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  },
] satisfies DesktopTimeEntryMatterCandidate[];
const MATTER_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;
/** The review runs a day after the fixtures; nothing here is learned. */
const NOW_MS = Date.UTC(2026, 9, 10);
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 9, 9, 0, seconds)).toISOString();
const segment = (
  start: number,
  end: number,
  title: string,
  matterId: string | null = null,
) => ({
  appIdentifier: "word",
  appName: "Word",
  start: at(start),
  end: at(end),
  windowTitle: title,
  matterId,
});
const review = (
  segments: ReturnType<typeof segment>[],
  captureDetails = true,
) =>
  matchDay({
    segments: timedSegments(segments),
    candidates,
    resolved: [],
    learning: EMPTY_MATTER_LEARNING,
    nowMs: NOW_MS,
    captureDetails,
    manualAssignments: [],
    draftedEntries: [],
  });

describe("local matter day review", () => {
  test("recorded matter IDs outside the candidate shortlist never become heuristic matches", () => {
    for (const captureDetails of [false, true]) {
      const result = review(
        [segment(0, 60, "A-101", "outside-shortlist")],
        captureDetails,
      );
      expect(result.segments.at(0)?.matterId).toBe("outside-shortlist");
      expect(result.segments.at(0)?.matter).toBeNull();
      expect(result.segments.at(0)?.confidence).toBe("unmatched");
      expect(result.segments.at(0)?.recordedMatter).toBe("unresolved");
    }
  });

  test("a recorded matter off the shortlist matches once resolved, and an inaccessible one is unavailable", () => {
    const outside = {
      ...ALPHA,
      id: "outside",
      name: "Outside matter",
      reference: "O-1",
    };
    const result = matchDay({
      segments: timedSegments([
        segment(0, 30, "A-101", "outside"),
        segment(30, 60, "A-101", "lost"),
      ]),
      candidates,
      resolved: [
        { type: "accessible", matter: outside },
        { type: "inaccessible", id: "lost" },
      ],
      learning: EMPTY_MATTER_LEARNING,
      nowMs: NOW_MS,
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
    });
    expect(
      result.segments.map(({ matter, confidence, recordedMatter }) => [
        matter?.id,
        confidence,
        recordedMatter,
      ]),
    ).toEqual([
      ["outside", "strong", "open"],
      [undefined, "unmatched", "unavailable"],
    ]);
  });

  test("only recorded matter ids no read answered for are asked for, each once", () => {
    const ids = recordedMatterIds({
      segments: [
        { matterId: MATTER_IDS[2] },
        { matterId: null },
        {},
        { matterId: MATTER_IDS[1] },
      ],
      manualAssignments: [
        { start: at(0), end: at(1), matterId: MATTER_IDS[0] },
        { start: at(1), end: at(2), matterId: MATTER_IDS[2] },
        { start: at(2), end: at(3), matterId: "not-a-matter-id" },
      ],
    });
    expect(ids).toEqual([
      MATTER_IDS[2],
      MATTER_IDS[1],
      MATTER_IDS[0],
      "not-a-matter-id",
    ]);
    expect(
      unresolvedMatterIds({
        ids,
        candidates: [{ ...ALPHA, id: MATTER_IDS[0] }],
        resolved: [{ type: "inaccessible", id: MATTER_IDS[1] }],
      }),
    ).toEqual([MATTER_IDS[2]]);
  });

  test("aggregates disconnected segments per matter without adding away time", () => {
    const result = review([
      segment(0, 90, "A-101"),
      segment(90, 240, "B-202"),
      segment(3600, 3690, "A-101"),
    ]);
    expect(
      result.groups.map(({ id, durationMs, workedMinutes }) => ({
        id,
        durationMs,
        workedMinutes,
      })),
    ).toEqual([
      { id: "a", durationMs: 180_000, workedMinutes: 3 },
      { id: "b", durationMs: 150_000, workedMinutes: 2 },
    ]);
    expect(
      result.groups.reduce((sum, group) => sum + group.durationMs, 0),
    ).toBe(330_000);
  });

  test("a matter recorded under two minutes is a brief touch, not a suggestion", () => {
    const result = review([segment(0, 5, "A-101"), segment(5, 300, "B-202")]);
    expect(
      result.groups.map(({ id, workedMinutes }) => [id, workedMinutes]),
    ).toEqual([["b", 4]]);
    expect(
      result.briefTouches.map(({ id, durationMs, workedMinutes }) => [
        id,
        durationMs,
        workedMinutes,
      ]),
    ).toEqual([["a", 5000, 1]]);
  });

  test("unclaimed time between two stretches of one matter is offered, never counted", () => {
    const result = review([
      segment(0, 120, "A-101"),
      segment(120, 170, "Inbox"),
      segment(170, 300, "A-101"),
    ]);
    const alpha = result.groups.find(({ id }) => id === "a");
    expect(alpha?.durationMs).toBe(250_000);
    expect(alpha?.slivers.map(({ startMs, endMs }) => endMs - startMs)).toEqual(
      [50_000],
    );
  });

  test("another matter's time, or time recorded with a matter not offered, is never a sliver", () => {
    for (const between of [
      segment(120, 170, "B-202"),
      segment(120, 170, "Inbox", "outside-shortlist"),
    ]) {
      const result = review([
        segment(0, 120, "A-101"),
        between,
        segment(170, 300, "A-101"),
      ]);
      expect(result.groups.find(({ id }) => id === "a")?.slivers).toEqual([]);
    }
  });

  test("unclaimed time of two minutes or more is no sliver", () => {
    const result = review([
      segment(0, 120, "A-101"),
      segment(120, 240, "Inbox"),
      segment(240, 360, "A-101"),
    ]);
    expect(result.groups.find(({ id }) => id === "a")?.slivers).toEqual([]);
  });

  test("taking slivers in after another matter's entry never claims more than was recorded", () => {
    const segments = timedSegments([
      segment(0, 156, "A-101"),
      segment(156, 234, "B-202"),
      segment(234, 240, "Inbox"),
      segment(240, 318, "B-202"),
    ]);
    type Options = Parameters<typeof matchDay>[0];
    const day = (
      manualAssignments: Options["manualAssignments"],
      draftedEntries: Options["draftedEntries"],
    ) =>
      matchDay({
        segments,
        candidates,
        resolved: [],
        learning: EMPTY_MATTER_LEARNING,
        nowMs: NOW_MS,
        captureDetails: true,
        manualAssignments,
        draftedEntries,
      });
    const alpha =
      day([], []).groups.find(({ id }) => id === "a") ??
      panic("Alpha is suggested");
    // Alpha's entry is created first, at the minutes it then claimed.
    const created = alpha.ranges.map((range) => ({
      ...range,
      entryId: "alpha-entry",
    }));
    const beta = day([], created).groups.find(({ id }) => id === "b");
    const included = (beta?.slivers ?? []).map(({ startMs, endMs }) => ({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      matterId: "b",
    }));
    const after = day(included, created);
    const matterMs = after.segments
      .filter(({ matter }) => matter !== null)
      .reduce((sum, { endMs, startMs }) => sum + endMs - startMs, 0);
    const suggestedMinutes = after.groups.reduce(
      (sum, { workedMinutes }) => sum + workedMinutes,
      0,
    );
    expect(
      (alpha.workedMinutes + suggestedMinutes) * 60_000,
    ).toBeLessThanOrEqual(matterMs);
  });

  test("an entry's rest under a minute is no brief touch; a minute or more adds rounded down", () => {
    const touches = (end: number) =>
      matchDay({
        segments: timedSegments([
          segment(0, end, "A-101"),
          segment(end, end + 300, "B-202"),
        ]),
        candidates,
        resolved: [],
        learning: EMPTY_MATTER_LEARNING,
        nowMs: NOW_MS,
        captureDetails: true,
        manualAssignments: [],
        draftedEntries: [{ start: at(0), end: at(120), entryId: "alpha" }],
      }).briefTouches.map(({ id, workedMinutes }) => [id, workedMinutes]);
    expect(touches(125)).toEqual([]);
    expect(touches(200)).toEqual([["a", 1]]);
  });

  test("session identity outranks tokens, and metadata only matches after consent", () => {
    const segments = [segment(0, 30, "B-202", "a"), segment(30, 60, "B-202")];
    expect(
      review(segments).segments.map(({ matter, confidence }) => [
        matter?.id,
        confidence,
      ]),
    ).toEqual([
      ["a", "strong"],
      ["b", "likely"],
    ]);
    const withoutConsent = review(segments, false);
    expect(withoutConsent.segments.map(({ matter }) => matter?.id)).toEqual([
      "a",
      undefined,
    ]);
    expect(
      withoutConsent.groups.every(
        ({ evidence, apps }) =>
          evidence.length === 0 &&
          apps.length === 1 &&
          apps.at(0)?.name === "Word",
      ),
    ).toBe(true);
  });
  test("token boundaries, Unicode normalization and shared clients do not invent matches", () => {
    for (const title of ["XA-1010", "Common client", "unrelated"]) {
      expect(review([segment(0, 30, title)]).groups.at(0)?.matter).toBeNull();
    }
    expect(
      review([segment(0, 30, "Ａ－１０１")]).segments.at(0)?.matter?.id,
    ).toBe("a");
    const { groups, briefTouches } = review([segment(0, 30, "B-202")]);
    const reversed = matchDay({
      segments: timedSegments([segment(0, 30, "B-202")]),
      candidates: candidates.toReversed(),
      resolved: [],
      learning: EMPTY_MATTER_LEARNING,
      nowMs: NOW_MS,
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
    });
    expect(groups).toEqual(reversed.groups);
    expect(briefTouches).toEqual(reversed.briefTouches);
  });
  test("distinctive whole name and client tokens match partial evidence without resolving ambiguity", () => {
    const matters = candidates.map((candidate) => ({
      ...candidate,
      name:
        candidate.id === "a"
          ? "Riverside lease renewal"
          : "Meadow lease review",
      clientName:
        candidate.id === "a" ? "Northbank Holdings" : "Southbank Holdings",
    }));
    const cases = [
      { title: "Riverside Lease v3.docx", expected: "a" },
      { title: "Re Riverside – break clause comments", expected: "a" },
      { title: "Northbank draft reply", expected: "a" },
      { title: "Ｒｉｖｅｒｓｉｄｅ draft", expected: "a" },
      { title: "Lease Holdings Re", expected: undefined },
      { title: "Riverside Meadow draft", expected: undefined },
      { title: "Riverside Southbank correspondence", expected: undefined },
      { title: "RiversideX Northbanker", expected: undefined },
      { title: "101 unrelated", expected: undefined },
    ];
    for (const ordered of [matters, matters.toReversed()]) {
      for (const { title, expected } of cases) {
        const result = matchDay({
          segments: timedSegments([segment(0, 30, title)]),
          candidates: ordered,
          resolved: [],
          learning: EMPTY_MATTER_LEARNING,
          nowMs: NOW_MS,
          captureDetails: true,
          manualAssignments: [],
          draftedEntries: [],
        });
        expect(result.segments.at(0)?.matter?.id, title).toBe(expected);
      }
      const strong = matchDay({
        segments: timedSegments([
          segment(0, 30, "Riverside Meadow Northbank Southbank", "b"),
        ]),
        candidates: ordered,
        resolved: [],
        learning: EMPTY_MATTER_LEARNING,
        nowMs: NOW_MS,
        captureDetails: true,
        manualAssignments: [],
        draftedEntries: [],
      });
      expect(strong.segments.at(0)?.matter?.id).toBe("b");
      expect(strong.segments.at(0)?.confidence).toBe("strong");
    }
  });
  test("manual and receipt boundaries partition duration exactly, and drafts exclude only their ranges", () => {
    for (let boundary = 1; boundary < 60; boundary++) {
      const original = timedSegments([segment(0, 60, "A-101")]);
      const result = matchDay({
        segments: original,
        candidates,
        resolved: [],
        learning: EMPTY_MATTER_LEARNING,
        nowMs: NOW_MS,
        captureDetails: true,
        manualAssignments: [
          { start: at(boundary), end: at(60), matterId: "b" },
        ],
        draftedEntries: [{ start: at(0), end: at(boundary), entryId: "entry" }],
      });
      expect(totalDurationMs(result.segments)).toBe(totalDurationMs(original));
      expect(result.groups).toHaveLength(1);
      expect(result.groups.at(0)?.matter?.id).toBe("b");
      expect(result.groups.at(0)?.durationMs).toBe((60 - boundary) * 1000);
      expect(result.segments.at(0)?.drafted).toBe(true);
    }
  });
  test("latest manual assignment wins and unavailable matters remain unmatched", () => {
    const result = matchDay({
      segments: timedSegments([segment(0, 60, "A-101", "a")]),
      candidates,
      resolved: [{ type: "inaccessible", id: "removed" }],
      learning: EMPTY_MATTER_LEARNING,
      nowMs: NOW_MS,
      captureDetails: true,
      manualAssignments: [
        { start: at(0), end: at(60), matterId: "b" },
        { start: at(10), end: at(20), matterId: "removed" },
      ],
      draftedEntries: [],
    });
    expect(
      result.segments.map(({ matter, recordedMatter }) => [
        matter?.id,
        recordedMatter,
      ]),
    ).toEqual([
      ["b", "open"],
      [undefined, "unavailable"],
      ["b", "open"],
    ]);
  });

  test("no suggestion ever names a matter outside the accessible set of the same read", () => {
    const pool = ["a", "b", "c", "d", "e"].map((id, index) => ({
      ...ALPHA,
      id,
      name: `${id.toUpperCase()}lpha matter ${String(index)}`,
      reference: `${id.toUpperCase()}-${String(index)}0${String(index)}`,
      clientName: `Client ${id}`,
    }));
    /** Where each pooled matter stands in one read. */
    const standing = fc.constantFrom(
      "shortlisted",
      "resolved",
      "inaccessible",
      "unanswered",
    );
    const pooledId = fc.constantFrom(...pool.map(({ id }) => id), "unknown");
    const windowTitle = fc
      .array(
        fc.oneof(
          fc.constantFrom(
            ...pool.flatMap(({ name, reference, clientName }) => [
              name,
              reference,
              clientName,
            ]),
          ),
          fc.constantFrom("draft", "notes", "Re:"),
        ),
        { maxLength: 3 },
      )
      .map((parts) => parts.join(" "));
    const recorded = fc.record({
      start: fc.integer({ min: 0, max: 50 }),
      length: fc.integer({ min: 1, max: 10 }),
      matterId: fc.option(pooledId, { nil: null }),
      title: windowTitle,
    });
    assertProperty(
      "no suggestion ever names a matter outside the accessible set of the same read",
      fc.property(
        fc.array(standing, { minLength: pool.length, maxLength: pool.length }),
        fc.array(recorded, { maxLength: 8 }),
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 50 }),
            length: fc.integer({ min: 1, max: 20 }),
            matterId: pooledId,
          }),
          { maxLength: 3 },
        ),
        fc.boolean(),
        (standings, recordedSegments, assignments, captureDetails) => {
          const shortlist = pool.filter(
            (_, index) => standings[index] === "shortlisted",
          );
          const resolved = pool.flatMap(
            (matter, index): DesktopMatterResolution[] => {
              const matterStanding = standings.at(index) ?? "unanswered";
              switch (matterStanding) {
                case "resolved":
                  return [{ type: "accessible", matter }];
                case "inaccessible":
                  return [{ type: "inaccessible", id: matter.id }];
                case "shortlisted":
                case "unanswered":
                  return [];
                default:
                  matterStanding satisfies never;
                  return [];
              }
            },
          );
          const open = new Map(
            [
              ...shortlist,
              ...resolved.flatMap((resolution) =>
                resolution.type === "accessible" ? [resolution.matter] : [],
              ),
            ].map((matter) => [matter.id, matter]),
          );
          const result = matchDay({
            segments: timedSegments(
              recordedSegments.map(({ start, length, matterId, title }) =>
                segment(start, start + length, title, matterId),
              ),
            ),
            candidates: shortlist,
            resolved,
            learning: EMPTY_MATTER_LEARNING,
            nowMs: NOW_MS,
            captureDetails,
            manualAssignments: assignments.map(
              ({ start, length, matterId }) => ({
                start: at(start),
                end: at(start + length),
                matterId,
              }),
            ),
            draftedEntries: [],
          });
          for (const { matter, recordedMatter } of [
            ...result.segments,
            ...result.groups.map((group) => ({
              matter: group.matter,
              recordedMatter: "none",
            })),
          ]) {
            if (matter !== null) {
              expect(open.get(matter.id)).toBe(matter);
            }
            if (recordedMatter === "unavailable") {
              expect(matter).toBeNull();
            }
          }
        },
      ),
    );
  });
});

/** The distinct own parts of `titles`, in order. */
const withoutSharedContext = (titles: readonly string[]) => {
  const cleaned = cleanSharedContext(titles);
  return [...new Set(titles.map((title) => cleaned.get(title) ?? title))];
};

describe("window title evidence", () => {
  test("drops a label that several titles share", () => {
    expect(
      withoutSharedContext([
        "home",
        "host: notes",
        "host: Local tooling",
        "host: stella",
        "Stella",
      ]),
    ).toEqual(["home", "notes", "Local tooling", "stella", "Stella"]);
    expect(
      withoutSharedContext(["build: release notes", "Smlouva o dílo.docx"]),
    ).toEqual(["build: release notes", "Smlouva o dílo.docx"]);
    expect(
      withoutSharedContext(["a: stella", "a: stella 2", "stella"]),
    ).toEqual(["stella", "stella 2"]);
    expect(
      withoutSharedContext([
        "Pull requests · stella/stella",
        "Merge queue · stella/stella",
        "Notifications",
        "Smlouva - návrh",
      ]),
    ).toEqual([
      "Pull requests",
      "Merge queue",
      "Notifications",
      "Smlouva - návrh",
    ]);
    expect(
      withoutSharedContext([
        "Pull requests · my-site.com",
        "Merge queue · my-site.com",
      ]),
    ).toEqual(["Pull requests", "Merge queue"]);
  });

  test("drops the browser and profile a title ends with", () => {
    expect(
      withoutAppSuffix(
        "Pull requests · stella/stella - Google Chrome – Jan (Osobní)",
        "Google Chrome",
      ),
    ).toEqual("Pull requests · stella/stella");
    expect(withoutAppSuffix("Inbox — Firefox", "Firefox")).toEqual("Inbox");
    expect(
      withoutAppSuffix("Google Chrome - Wikipedia", "Google Chrome"),
    ).toEqual("Google Chrome - Wikipedia");
    expect(
      withoutAppSuffix("Notes - Google Chromebook", "Google Chrome"),
    ).toEqual("Notes - Google Chromebook");
    expect(
      withoutAppSuffix(
        "Notes - Google Chromebook - Google Chrome",
        "Google Chrome",
      ),
    ).toEqual("Notes - Google Chromebook");
  });

  test("lists each app's own titles, the longest-used first", () => {
    const window = (
      start: number,
      end: number,
      [appIdentifier, appName]: readonly [string, string],
      windowTitle: string,
    ) => ({
      appIdentifier,
      appName,
      start: at(start),
      end: at(end),
      windowTitle,
      matterId: null,
    });
    const terminal = ["ghostty", "Ghostty"] as const;
    const chrome = ["chrome", "Google Chrome"] as const;
    const [group] = matchDay({
      segments: timedSegments([
        window(0, 10, terminal, "host: notes"),
        window(10, 40, terminal, "host: stella"),
        window(40, 50, chrome, "Merge queue - Google Chrome - Jan"),
        window(50, 55, chrome, "Google Chrome"),
      ]),
      candidates,
      resolved: [],
      learning: EMPTY_MATTER_LEARNING,
      nowMs: NOW_MS,
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
    }).groups;
    expect(group?.evidence).toEqual([
      {
        identifier: "ghostty",
        name: "Ghostty",
        details: [
          { title: "stella", durationMs: 30_000, matter: null },
          { title: "notes", durationMs: 10_000, matter: null },
        ],
      },
      {
        identifier: "chrome",
        name: "Google Chrome",
        details: [{ title: "Merge queue", durationMs: 10_000, matter: null }],
      },
    ]);
  });
});

describe("time recorded elsewhere on a suggestion's matter", () => {
  const drafted = (entryId: string) => ({
    start: at(0),
    end: at(60),
    entryId,
  });
  const entry = (id: string, matterId: string, durationMinutes: number) => ({
    id,
    matterId,
    durationMinutes,
  });

  test("counts the matter's entries this computer did not create", () => {
    expect(
      recordedElsewhere({
        dayEntries: {
          type: "ready",
          entries: [
            entry("mine", "a", 30),
            entry("laptop", "a", 60),
            entry("web", "a", 30),
            entry("other-matter", "b", 45),
          ],
        },
        draftedEntries: [drafted("mine")],
        matterId: "a",
      }),
    ).toEqual({ type: "recorded", minutes: 90 });
  });

  test("says nothing when only this computer recorded the matter, and warns of a day it could not read", () => {
    const ready = {
      type: "ready",
      entries: [entry("mine", "a", 30)],
    } satisfies DayEntriesRead;
    expect(
      recordedElsewhere({
        dayEntries: ready,
        draftedEntries: [drafted("mine")],
        matterId: "a",
      }),
    ).toEqual({ type: "none" });
    expect(
      recordedElsewhere({
        dayEntries: ready,
        draftedEntries: [],
        matterId: null,
      }),
    ).toEqual({ type: "none" });
    expect(
      recordedElsewhere({
        dayEntries: { type: "loading" },
        draftedEntries: [],
        matterId: "a",
      }),
    ).toEqual({ type: "none" });
    expect(
      recordedElsewhere({
        dayEntries: { type: "failed" },
        draftedEntries: [],
        matterId: "a",
      }),
    ).toEqual({ type: "unknown" });
  });

  test("this computer's own entries never add to the warning", () => {
    assertProperty(
      "this computer's own entries never add to the warning",
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.uuid(),
            matterId: fc.constantFrom("a", "b"),
            durationMinutes: fc.integer({ min: 0, max: 1440 }),
            ownedHere: fc.boolean(),
          }),
          { maxLength: 20, selector: ({ id }) => id },
        ),
        (rows) => {
          const status = recordedElsewhere({
            dayEntries: {
              type: "ready",
              entries: rows.map(({ id, matterId, durationMinutes }) =>
                entry(id, matterId, durationMinutes),
              ),
            },
            draftedEntries: rows
              .filter(({ ownedHere }) => ownedHere)
              .map(({ id }) => drafted(id)),
            matterId: "a",
          });
          const elsewhere = rows
            .filter(({ matterId, ownedHere }) => matterId === "a" && !ownedHere)
            .reduce((sum, { durationMinutes }) => sum + durationMinutes, 0);
          expect(status).toEqual(
            elsewhere > 0
              ? { type: "recorded", minutes: elsewhere }
              : { type: "none" },
          );
        },
      ),
    );
  });
});
