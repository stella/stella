import { describe, expect, test } from "bun:test";

import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";

import { timedSegments, totalDurationMs } from "./activity-logic";
import { matchDay } from "./day-review-logic";

const candidates = [
  {
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
  },
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
    captureDetails,
    manualAssignments: [],
    draftedEntries: [],
  });

describe("local matter day review", () => {
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
        ({ evidence, narrative }) =>
          evidence.length === 0 && narrative === "Word",
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
      captureDetails: true,
      manualAssignments: [
        { start: at(0), end: at(60), matterId: "b" },
        { start: at(10), end: at(20), matterId: "removed" },
      ],
      draftedEntries: [],
    });
    expect(result.segments.map(({ matter }) => matter?.id)).toEqual([
      "b",
      undefined,
      "b",
    ]);
  });
});
