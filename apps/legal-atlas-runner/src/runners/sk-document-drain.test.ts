/**
 * The walk's throughput is its sleep policy, and a wrong one is silent:
 * bursting looks like a healthy walk to everything except the publisher
 * being fetched from, and a loop that stops after the first failure
 * looks exactly like an empty queue. Both are pinned here.
 *
 * Pacing waits are sliced to stay interruptible, so assertions read the
 * summed gap between queue polls or fetches, never individual sleeps.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { DocumentAst } from "@/api/lib/case-law/document-ast";
import type {
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import type {
  PendingDocumentQueue,
  QueuedDocument,
} from "@/api/lib/legal-search/sk-document-queue";
import { DOCUMENT_TIER } from "@/api/lib/legal-search/sk-document-queue";

import {
  DRAIN_CHECK_SLICE_MS,
  type SkDocumentDrainSummary,
  type SkDocumentDrainTiming,
  runSkDocumentDrain,
} from "./sk-document-drain";

const TIMING = {
  fetchDelayMs: 500,
  idleSleepMs: 1000,
  idleSleepMaxMs: 8000,
  summaryIntervalMs: 10_000,
  failureBackoffMaxMs: 4000,
} as const satisfies SkDocumentDrainTiming;

const EMPTY_AST: DocumentAst = {
  version: 1,
  source: {
    system: "obcan.justice.sk",
    documentId: "drain",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "1T/1/2026",
    ecli: null,
    court: "Okresný súd Bratislava I",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [],
};

/**
 * One outcome per status the unit can return. Total over the union, so
 * a new outcome has to be given a pacing answer here rather than
 * quietly inheriting one.
 */
const OUTCOMES = {
  filled: {
    status: "filled",
    document: { fulltext: "text", documentAst: EMPTY_AST, sections: [] },
  },
  unavailable: { status: "unavailable" },
  claimed: { status: "claimed" },
  superseded: { status: "superseded" },
} as const satisfies Record<
  DecisionDocumentOutcome["status"],
  DecisionDocumentOutcome
>;

/** Derived from the total record above, so it cannot fall behind it. */
const OUTCOME_STATUSES = Object.values(OUTCOMES).map(({ status }) => status);

const pending = (caseNumber: string): PendingDocument => ({
  id: toSafeId<"caseLawDecision">(`decision-${caseNumber}`),
  caseNumber,
  ecli: null,
  court: "Okresný súd Bratislava I",
  country: "SVK",
  decisionDate: null,
  decisionType: null,
  documentUrl: `https://example.test/${caseNumber}.pdf`,
});

/** Hands out the given documents, then reports the queue as empty. */
const queueOf = (caseNumbers: readonly string[]): PendingDocumentQueue => {
  const remaining = [...caseNumbers];
  return {
    next: async (): Promise<QueuedDocument | undefined> => {
      const caseNumber = remaining.shift();
      return await Promise.resolve(
        caseNumber === undefined
          ? undefined
          : { tier: DOCUMENT_TIER.REMAINING, decision: pending(caseNumber) },
      );
    },
  };
};

type DrainEvent =
  | { type: "poll" }
  | { type: "fetch"; caseNumber: string }
  | { type: "sleep"; ms: number };

type DrainRun = {
  events: DrainEvent[];
  summaries: SkDocumentDrainSummary[];
  clock: number;
};

type RunDrainOptions = {
  queue: PendingDocumentQueue;
  /** Answers one fetch; throwing stands in for a transient failure. */
  respond: (decision: PendingDocument) => DecisionDocumentOutcome;
  /** Queue polls to allow before the walk is asked to drain. */
  polls: number;
  /** Additionally drain once the fake clock reaches this, mid-wait. */
  drainAtClock?: number;
  timing?: SkDocumentDrainTiming;
};

const runDrain = async ({
  drainAtClock,
  polls,
  queue,
  respond,
  timing = TIMING,
}: RunDrainOptions): Promise<DrainRun> => {
  const events: DrainEvent[] = [];
  const summaries: SkDocumentDrainSummary[] = [];
  let clock = 0;
  let polled = 0;
  let draining = false;

  await runSkDocumentDrain({
    queue: {
      next: async () => {
        events.push({ type: "poll" });
        polled += 1;
        draining ||= polled >= polls;
        return await queue.next();
      },
    },
    fetchDocument: async (decision) => {
      events.push({ type: "fetch", caseNumber: decision.caseNumber });
      return await Promise.resolve(respond(decision));
    },
    isDraining: () => draining,
    now: () => clock,
    report: (summary) => {
      summaries.push({ ...summary });
    },
    sleep: async (ms) => {
      events.push({ type: "sleep", ms });
      clock += ms;
      draining ||= drainAtClock !== undefined && clock >= drainAtClock;
      await Promise.resolve();
    },
    timing,
  });

  return { events, summaries, clock };
};

/** Summed sleeps recorded between consecutive events of one type. */
const gapsBetween = (
  { events }: DrainRun,
  boundary: DrainEvent["type"],
): number[] => {
  const gaps: number[] = [];
  let sinceBoundary: number | undefined;
  for (const event of events) {
    if (event.type === boundary) {
      if (sinceBoundary !== undefined) {
        gaps.push(sinceBoundary);
      }
      sinceBoundary = 0;
      continue;
    }
    if (event.type === "sleep" && sinceBoundary !== undefined) {
      sinceBoundary += event.ms;
    }
  }
  return gaps;
};

describe("sk document drain", () => {
  test("every outcome is followed by the same fetch gap", async () => {
    // A burst is what happens when some outcome is treated as "no
    // download happened": an unavailable document and a store the source
    // overtook each cost the publisher a request just the same, and a
    // claimed one cost a round trip. None may pace faster.
    const outcomeByCaseNumber = new Map(
      OUTCOME_STATUSES.map((status) => [`doc-${status}`, OUTCOMES[status]]),
    );
    const run = await runDrain({
      queue: queueOf([...outcomeByCaseNumber.keys()]),
      respond: ({ caseNumber }) =>
        outcomeByCaseNumber.get(caseNumber) ??
        panic(`no outcome scripted for ${caseNumber}`),
      polls: OUTCOME_STATUSES.length,
    });

    expect(run.events.filter(({ type }) => type === "fetch")).toHaveLength(
      OUTCOME_STATUSES.length,
    );
    expect(gapsBetween(run, "fetch")).toEqual(
      Array.from(
        { length: OUTCOME_STATUSES.length - 1 },
        () => TIMING.fetchDelayMs,
      ),
    );
  });

  test("a failing fetch neither wedges the walk nor speeds it up", async () => {
    const run = await runDrain({
      queue: queueOf(["doc-1", "doc-2", "doc-3"]),
      respond: ({ caseNumber }) => {
        if (caseNumber === "doc-1") {
          throw new Error("transient");
        }
        return OUTCOMES.filled;
      },
      polls: 3,
    });

    // The walk carried on past the throw...
    expect(
      run.events.flatMap((event) =>
        event.type === "fetch" ? [event.caseNumber] : [],
      ),
    ).toEqual(["doc-1", "doc-2", "doc-3"]);
    // ...and paid for it, rather than retrying at full speed.
    expect(gapsBetween(run, "fetch").at(0)).toBeGreaterThan(
      TIMING.fetchDelayMs,
    );
  });

  test("a run of failures backs off to the ceiling and no further", async () => {
    const run = await runDrain({
      queue: queueOf(Array.from({ length: 12 }, (_, i) => `doc-${i}`)),
      respond: () => {
        throw new Error("unreachable");
      },
      polls: 12,
    });

    const gaps = gapsBetween(run, "poll");
    const notIncreasing = gaps.filter(
      (ms, i) => i > 0 && ms < (gaps[i - 1] ?? 0),
    );

    expect(notIncreasing).toEqual([]);
    expect(gaps.at(0)).toBe(TIMING.fetchDelayMs * 2);
    expect(gaps.at(-1)).toBe(TIMING.failureBackoffMaxMs);
  });

  test("an empty queue backs off instead of polling at the fetch rate", async () => {
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      polls: 5,
    });

    expect(run.events.filter(({ type }) => type === "fetch")).toEqual([]);
    expect(gapsBetween(run, "poll")).toEqual([1000, 2000, 4000, 8000]);
  });

  test("a document found resets the idle backoff", async () => {
    // Without the reset a walk that caught up once would keep polling on
    // the idle ceiling while a fresh crawl page piles up behind it.
    const emptyThenWork: PendingDocumentQueue = (() => {
      const script = [undefined, undefined, pending("doc-1"), pending("doc-2")];
      return {
        next: async () => {
          const decision = script.shift();
          return await Promise.resolve(
            decision === undefined
              ? undefined
              : { tier: DOCUMENT_TIER.REMAINING, decision },
          );
        },
      };
    })();

    const run = await runDrain({
      queue: emptyThenWork,
      respond: () => OUTCOMES.filled,
      polls: 4,
    });

    expect(gapsBetween(run, "poll")).toEqual([1000, 2000, TIMING.fetchDelayMs]);
  });

  test("every pacing wait stays interruptible: no sleep exceeds one slice", async () => {
    // The idle ceiling is minutes in production; a SIGTERM must interrupt
    // it within a slice instead of waiting it out.
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      polls: 5,
    });

    const oversleeps = run.events.filter(
      (event) => event.type === "sleep" && event.ms > DRAIN_CHECK_SLICE_MS,
    );
    expect(oversleeps).toEqual([]);
  });

  test("a drain request interrupts an idle wait mid-gap", async () => {
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      polls: Number.POSITIVE_INFINITY,
      timing: { ...TIMING, idleSleepMs: 3500 },
      drainAtClock: 1500,
    });

    // The 3500ms idle gap ended after two slices, not four: the walk
    // noticed the drain request without waiting the gap out.
    expect(run.clock).toBe(2000);
    expect(run.events.filter(({ type }) => type === "poll")).toHaveLength(1);
  });

  test("the summary tallies the window and is emitted once per interval", async () => {
    const run = await runDrain({
      queue: queueOf(["doc-1", "doc-2", "doc-3"]),
      respond: ({ caseNumber }) =>
        caseNumber === "doc-2" ? OUTCOMES.unavailable : OUTCOMES.filled,
      polls: 3,
    });

    // Three fetches at 500ms never reach the 10s interval, so the only
    // summary is the one the drain flushes on the way out: a process
    // replaced mid-window must not take its tallies with it.
    expect(run.summaries).toHaveLength(1);
    expect(run.summaries.at(0)).toMatchObject({
      attempted: 3,
      filled: 2,
      unavailable: 1,
      claimed: 0,
      superseded: 0,
      failed: 0,
    });
  });

  test("a long window emits periodic summaries and resets the tally between them", async () => {
    // Six documents at a 1s summary interval: the walk crosses the
    // interval mid-run, so the tallies must arrive in windows rather
    // than only at shutdown, and a window must not re-report its
    // predecessor's counts.
    const run = await runDrain({
      queue: queueOf(Array.from({ length: 6 }, (_, i) => `doc-${i}`)),
      respond: () => OUTCOMES.filled,
      polls: 6,
      timing: { ...TIMING, summaryIntervalMs: 1000 },
    });

    expect(run.summaries.length).toBeGreaterThan(1);
    const attempted = run.summaries.map(({ attempted: count }) => count);
    expect(attempted.reduce((sum, count) => sum + count, 0)).toBe(6);
    // Every window carries only its own tally, so none reports all six.
    expect(Math.max(...attempted)).toBeLessThan(6);
  });

  test("an idle window reports nothing at all", async () => {
    // Progress and error rate are the signal; a stream of zero-rows
    // summaries would bury both. Liveness is the daemon's heartbeat.
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      polls: 30,
    });

    expect(run.summaries).toEqual([]);
  });

  test("a failure is reported with the error that caused it", async () => {
    const failure = new Error("transient");
    const run = await runDrain({
      queue: queueOf(["doc-1"]),
      respond: () => {
        throw failure;
      },
      polls: 1,
    });

    expect(run.summaries.at(0)).toMatchObject({
      attempted: 1,
      failed: 1,
      lastError: failure,
    });
  });
});
