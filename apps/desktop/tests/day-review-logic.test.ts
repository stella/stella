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
  recordedMatterIds,
  unresolvedMatterIds,
  withoutAppSuffix,
} from "../src/activity/day-review-logic";
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

  test("aggregates disconnected short segments per matter without adding away time", () => {
    const result = review([
      segment(0, 30, "A-101"),
      segment(30, 60, "B-202"),
      segment(3600, 3630, "A-101"),
    ]);
    expect(
      result.groups.map(({ id, durationMs, roundedTenths }) => ({
        id,
        durationMs,
        roundedTenths,
      })),
    ).toEqual([
      { id: "a", durationMs: 60_000, roundedTenths: 1 },
      { id: "b", durationMs: 30_000, roundedTenths: 1 },
    ]);
    expect(
      result.groups.reduce((sum, group) => sum + group.durationMs, 0),
    ).toBe(90_000);
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
      review([segment(0, 30, "Ａ－１０１")]).groups.at(0)?.matter?.id,
    ).toBe("a");
    expect(review([segment(0, 30, "B-202")]).groups).toEqual(
      matchDay({
        segments: timedSegments([segment(0, 30, "B-202")]),
        candidates: candidates.toReversed(),
        resolved: [],
        learning: EMPTY_MATTER_LEARNING,
        nowMs: NOW_MS,
        captureDetails: true,
        manualAssignments: [],
        draftedEntries: [],
      }).groups,
    );
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
