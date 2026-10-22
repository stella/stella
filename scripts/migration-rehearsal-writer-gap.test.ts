import { describe, expect, test } from "bun:test";

import {
  formatWriterEvent,
  judgeWriterGap,
  parseWriterEvent,
  writerGapReport,
} from "./migration-rehearsal-writer-gap";
import type { WriterEvent } from "./migration-rehearsal-writer-gap";

const window = { startMs: 10_000, endMs: 20_000 };

const commit = (session: number, at: number): WriterEvent => ({
  kind: "commit",
  session,
  at,
});
const refused = (session: number, at: number): WriterEvent => ({
  kind: "refused",
  session,
  at,
});

/** Commits every `everyMs` on each session across the whole window. */
const steadyCommits = (sessions: number, everyMs: number): WriterEvent[] =>
  Array.from({ length: sessions }, (_, session) =>
    Array.from(
      { length: Math.floor((window.endMs - window.startMs) / everyMs) + 1 },
      (_unused, index) => commit(session, window.startMs + index * everyMs),
    ),
  ).flat();

describe("writer event lines", () => {
  test("round-trip through the log format", () => {
    for (const event of [commit(1, 1_792_091_846_282), refused(0, 5)]) {
      expect(parseWriterEvent(formatWriterEvent(event))).toEqual(event);
    }
  });

  test("ignore every other line, including one cut off by the kill", () => {
    for (const line of [
      "contending: locks held",
      "",
      "writer-event commit 0",
      "writer-event commit 0 12",
      "writer-event commit 0 12 extra",
      "writer-event vacuum 0 12",
      "writer-event commit -1 12",
      "writer-event commit 0 1.5",
      "writer-events commit 0 12",
    ]) {
      expect(parseWriterEvent(line)).toEqual(
        line === "writer-event commit 0 12" ? commit(0, 12) : null,
      );
    }
  });
});

describe("writerGapReport", () => {
  test("steady writers report their commit interval", () => {
    const report = writerGapReport({
      events: steadyCommits(2, 1000),
      window,
      sessions: 2,
    });
    expect(report.maxGapMs).toBe(1000);
    expect(report.commits).toBe(22);
    expect(report.refusals).toBe(0);
  });

  test("a stall between commits is the gap, refusals counted", () => {
    const report = writerGapReport({
      events: [
        commit(0, 11_000),
        refused(0, 11_500),
        refused(0, 12_000),
        commit(0, 18_000),
        commit(0, 19_500),
        ...steadyCommits(2, 1000).filter((event) => event.session === 1),
      ],
      window,
      sessions: 2,
    });
    expect(report.maxGapMs).toBe(7000);
    expect(report.sessions[0]).toEqual({
      session: 0,
      maxGapMs: 7000,
      commits: 3,
      refusals: 2,
    });
    expect(report.refusals).toBe(2);
  });

  test("the window's edges count: a writer stuck at the start or the end is kept out", () => {
    const late = writerGapReport({
      events: [commit(0, 18_000)],
      window,
      sessions: 1,
    });
    expect(late.maxGapMs).toBe(8000);
    const stopped = writerGapReport({
      events: [commit(0, 12_000)],
      window,
      sessions: 1,
    });
    expect(stopped.maxGapMs).toBe(8000);
  });

  test("a session with no commits at all was kept out for the whole window", () => {
    const report = writerGapReport({
      events: steadyCommits(1, 1000),
      window,
      sessions: 2,
    });
    expect(report.maxGapMs).toBe(10_000);
    expect(report.sessions[1]).toEqual({
      session: 1,
      maxGapMs: 10_000,
      commits: 0,
      refusals: 0,
    });
  });

  test("events outside the window or from unknown sessions are ignored", () => {
    const report = writerGapReport({
      events: [
        commit(0, 1000),
        commit(0, 10_500),
        commit(0, 19_800),
        commit(0, 40_000),
        commit(7, 15_000),
      ],
      window,
      sessions: 1,
    });
    expect(report.maxGapMs).toBe(9300);
    expect(report.commits).toBe(2);
  });

  test("the gap never exceeds the window, whatever the commit pattern", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const events = Array.from({ length: seed % 17 }, (_, index) =>
        commit(
          (seed + index) % 3,
          window.startMs + ((seed * 7919 + index * 104_729) % 10_001),
        ),
      ).toSorted((left, right) => left.at - right.at);
      const report = writerGapReport({ events, window, sessions: 3 });
      expect(report.maxGapMs).toBeGreaterThanOrEqual(0);
      expect(report.maxGapMs).toBeLessThanOrEqual(
        window.endMs - window.startMs,
      );
      expect(report.commits).toBe(events.length);
    }
  });
});

describe("judgeWriterGap", () => {
  const steady = writerGapReport({
    events: steadyCommits(2, 5000),
    window,
    sessions: 2,
  });

  test("passes writers that kept committing", () => {
    expect(judgeWriterGap(steady, 60)).toEqual({
      kind: "within",
      summary: "5.0s of 60s, 6 commits, 0 lane refusals",
    });
  });

  test("fails a writer kept out past the budget, naming the gap", () => {
    const verdict = judgeWriterGap(
      writerGapReport({
        events: [commit(0, 10_500), refused(0, 11_000), commit(0, 19_000)],
        window,
        sessions: 1,
      }),
      5,
    );
    expect(verdict).toEqual({
      kind: "over",
      summary: "8.5s of 5s, 2 commits, 1 lane refusals",
      message:
        "Corpus writers were kept out for 8.5s (budget 5s) during the upgrade.",
    });
  });

  test("fails an empty contender log instead of passing it", () => {
    expect(
      judgeWriterGap(writerGapReport({ events: [], window, sessions: 2 }), 5)
        .kind,
    ).toBe("over");
  });

  test("a gap exactly on the budget passes", () => {
    expect(judgeWriterGap(steady, 5).kind).toBe("within");
  });
});
