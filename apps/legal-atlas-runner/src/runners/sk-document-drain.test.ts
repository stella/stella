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

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  DecisionDocumentOutcome,
  PendingDocument,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { PendingDocumentQueue } from "@/api/lib/legal-search/sk-document-queue";
import {
  createPendingDocumentQueue,
  DOCUMENT_TIER,
} from "@/api/lib/legal-search/sk-document-queue";

import {
  DRAIN_CHECK_SLICE_MS,
  type SkDocumentDrainOptions,
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
  busy: { status: "busy" },
  lost: { status: "lost" },
  superseded: { status: "superseded" },
  deferred: {
    status: "deferred",
    failure: "publisher-status",
    detail: "http-400",
  },
  parked: {
    status: "parked",
    failure: "unparseable",
    detail: "UnrecoverableParseError",
  },
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
    next: async () => {
      const caseNumber = remaining.shift();
      return await Promise.resolve(
        caseNumber === undefined
          ? { type: "exhausted" }
          : {
              type: "row",
              row: {
                tier: DOCUMENT_TIER.REMAINING,
                decision: pending(caseNumber),
              },
            },
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
  documentObservations?: SkDocumentDrainOptions["documentObservations"];
  /** A queue, or one built over the run's fake clock. */
  queue: PendingDocumentQueue | ((now: () => number) => PendingDocumentQueue);
  /** Answers one fetch; throwing stands in for a transient failure. */
  respond: (decision: PendingDocument) => DecisionDocumentOutcome;
  /** Queue polls to allow before the walk is asked to drain. */
  polls: number;
  /** Additionally drain once the fake clock reaches this, mid-wait. */
  drainAtClock?: number;
  timing?: SkDocumentDrainTiming;
};

const runDrain = async ({
  documentObservations,
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
  const source = typeof queue === "function" ? queue(() => clock) : queue;

  await runSkDocumentDrain({
    ...(documentObservations === undefined ? {} : { documentObservations }),
    queue: {
      next: async () => {
        events.push({ type: "poll" });
        polled += 1;
        draining ||= polled >= polls;
        return await source.next();
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

describe("source-keyed deferred document observations", () => {
  test("each drain outcome is accumulated with the five-minute discriminator and backlog probe", async () => {
    for (const status of OUTCOME_STATUSES) {
      const observations: DocumentStageObservation[] = [];
      let probes = 0;
      await runDrain({
        queue: queueOf(["fixture"]),
        respond: () => OUTCOMES[status],
        polls: 1,
        documentObservations: {
          source: "sk-courts",
          observe: (event) => {
            observations.push(event);
          },
          hasPending: async () => {
            probes += 1;
            return true;
          },
        },
      });
      expect(probes).toBe(1);
      expect(observations).toEqual([
        {
          event: DOCUMENT_FETCH_EVENT.window,
          aggregation: "five_minute",
          source: "sk-courts",
          backlog: 1,
          attempted: 1,
          filled: status === "filled" ? 1 : 0,
          failed: status === "deferred" || status === "parked" ? 1 : 0,
          window_seconds: 0,
        },
      ]);
    }
  });

  test("idle intervals report an empty backlog without producing legacy empty summaries", async () => {
    const observations: DocumentStageObservation[] = [];
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      polls: 4,
      timing: { ...TIMING, summaryIntervalMs: 1000 },
      documentObservations: {
        source: "sk-courts",
        observe: (event) => {
          observations.push(event);
        },
        hasPending: async () => false,
      },
    });
    expect(run.summaries).toEqual([]);
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "five_minute",
        source: "sk-courts",
        backlog: 0,
        attempted: 0,
        filled: 0,
        failed: 0,
      });
      if (observation.event === DOCUMENT_FETCH_EVENT.window) {
        expect(observation.window_seconds).toBeGreaterThan(0);
      }
    }
  });

  test("backlog probe failure cannot turn a stalled source into a healthy empty source", async () => {
    const observations: DocumentStageObservation[] = [];
    const run = await runDrain({
      queue: queueOf(["fixture"]),
      respond: () => OUTCOMES.deferred,
      polls: 1,
      documentObservations: {
        source: "sk-courts",
        observe: (event) => {
          observations.push(event);
        },
        hasPending: async () => {
          throw new Error("private query context");
        },
      },
    });
    expect(observations).toEqual([
      {
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source: "sk-courts",
        outcome: "unknown",
      },
      {
        event: DOCUMENT_FETCH_EVENT.window,
        aggregation: "five_minute",
        source: "sk-courts",
        backlog: 1,
        attempted: 1,
        filled: 0,
        failed: 2,
        window_seconds: 0,
      },
    ]);
    expect(run.summaries.at(0)?.failed).toBe(0);
    expect(JSON.stringify(observations)).not.toContain("private");
  });
});

/** Fake-clock time at which the walk fetched this document. */
const fetchedAt = ({ events }: DrainRun, caseNumber: string): number => {
  let clock = 0;
  for (const event of events) {
    if (event.type === "sleep") {
      clock += event.ms;
    }
    if (event.type === "fetch" && event.caseNumber === caseNumber) {
      return clock;
    }
  }
  return Number.POSITIVE_INFINITY;
};

type BacklogRow = {
  caseNumber: string;
  failing: boolean;
  attemptedAt: number | undefined;
  done: boolean;
};

type BacklogOptions = {
  rows: BacklogRow[];
  now: () => number;
  cooldownMs: number;
};

/**
 * The queue's contract in miniature: newest first, and a decision handed
 * out is not handed out again until its own cooldown has passed.
 */
const backlogQueue = ({
  cooldownMs,
  now,
  rows,
}: BacklogOptions): PendingDocumentQueue => ({
  next: async () => {
    const row = rows.find(
      ({ attemptedAt, done }) =>
        !done &&
        (attemptedAt === undefined || now() - attemptedAt >= cooldownMs),
    );
    if (row === undefined) {
      return { type: "exhausted" };
    }
    row.attemptedAt = now();
    return await Promise.resolve({
      type: "row",
      row: { tier: DOCUMENT_TIER.REMAINING, decision: pending(row.caseNumber) },
    });
  },
});

type BacklogRunOptions = {
  failingFront: number;
  behind: number;
  /** How a failing document answers: as an outcome, or by throwing. */
  failure: "outcome" | "throw";
};

type BacklogRun = { run: DrainRun; behindCaseNumbers: string[] };

/**
 * A backlog whose newest `failingFront` documents always fail, with
 * `behind` fetchable ones after them. The cooldown outlasts one pass
 * over the whole backlog, as the real one does by orders of magnitude.
 */
const runBacklog = async ({
  behind,
  failingFront,
  failure,
}: BacklogRunOptions): Promise<BacklogRun> => {
  const rows: BacklogRow[] = Array.from(
    { length: failingFront + behind },
    (_, i) => ({
      caseNumber: `doc-${i}`,
      failing: i < failingFront,
      attemptedAt: undefined,
      done: false,
    }),
  );
  const byCaseNumber = new Map(rows.map((row) => [row.caseNumber, row]));
  const run = await runDrain({
    queue: (now) =>
      backlogQueue({
        rows,
        now,
        cooldownMs: (rows.length + 1) * TIMING.failureBackoffMaxMs,
      }),
    respond: ({ caseNumber }) => {
      const row =
        byCaseNumber.get(caseNumber) ?? panic(`unknown ${caseNumber}`);
      if (!row.failing) {
        row.done = true;
        return OUTCOMES.filled;
      }
      if (failure === "throw") {
        throw new Error("refused");
      }
      return OUTCOMES.deferred;
    },
    polls: rows.length,
  });
  return {
    run,
    behindCaseNumbers: rows.slice(failingFront).map((row) => row.caseNumber),
  };
};

describe("sk document drain", () => {
  test("a failing front of any size cannot starve the documents behind it", async () => {
    // Every document behind the front is fetched within one fetch gap per
    // document ahead of it, whatever the front's size: a document's own
    // failure costs the walk one gap and nothing more.
    for (const failingFront of [0, 1, 2, 5, 13, 40, 100]) {
      for (const behind of [1, 3, 10]) {
        const { behindCaseNumbers, run } = await runBacklog({
          behind,
          failingFront,
          failure: "outcome",
        });

        for (const [i, caseNumber] of behindCaseNumbers.entries()) {
          expect({
            failingFront,
            caseNumber,
            at: fetchedAt(run, caseNumber),
          }).toEqual({
            failingFront,
            caseNumber,
            at: (failingFront + i) * TIMING.fetchDelayMs,
          });
        }
      }
    }
  });

  test("the same front, answered by throwing, would starve them", async () => {
    // Guards the property above against going vacuous: a walk that backs
    // off on every failure pays the ceiling per failing document, so the
    // same backlog reaches the documents behind it far later.
    const failingFront = 40;
    const { behindCaseNumbers, run } = await runBacklog({
      behind: 1,
      failingFront,
      failure: "throw",
    });
    const first = behindCaseNumbers.at(0) ?? panic("backlog has no rows");

    expect(fetchedAt(run, first)).toBeGreaterThan(
      failingFront * TIMING.fetchDelayMs * 2,
    );
  });

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

  test("a spent scan budget continues at the fetch gap until exhaustion permits idle backoff", async () => {
    let scans = 0;
    const run = await runDrain({
      queue: (now) =>
        createPendingDocumentQueue({
          now,
          pageSize: 20,
          requestedPollIntervalMs: 1000,
          loaders: {
            loadRequested: async () => [],
            loadRemaining: async () => {
              scans += 1;
              if (scans <= 3) {
                return { type: "budget-spent" };
              }
              if (scans === 4) {
                return { type: "rows", rows: [pending("ready-after-budgets")] };
              }
              return { type: "exhausted" };
            },
          },
        }),
      respond: () => OUTCOMES.filled,
      polls: 9,
    });

    expect(fetchedAt(run, "ready-after-budgets")).toBe(3 * TIMING.fetchDelayMs);
    expect(gapsBetween(run, "poll")).toEqual([
      TIMING.fetchDelayMs,
      TIMING.fetchDelayMs,
      TIMING.fetchDelayMs,
      TIMING.fetchDelayMs,
      1000,
      2000,
      4000,
      8000,
    ]);
    expect(run.summaries.at(0)).toMatchObject({
      attempted: 1,
      filled: 1,
      failed: 0,
    });
  });

  test("an exhausted queue backs off instead of polling at the fetch rate", async () => {
    const run = await runDrain({
      queue: (now) =>
        createPendingDocumentQueue({
          now,
          pageSize: 20,
          requestedPollIntervalMs: 1000,
          loaders: {
            loadRequested: async () => [],
            loadRemaining: async () => ({ type: "exhausted" }),
          },
        }),
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
              ? { type: "exhausted" }
              : {
                  type: "row",
                  row: { tier: DOCUMENT_TIER.REMAINING, decision },
                },
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

  test("a document's own failure is tallied by class, not as a walk failure", async () => {
    const run = await runDrain({
      queue: queueOf(["doc-1", "doc-2", "doc-3"]),
      respond: ({ caseNumber }) => {
        if (caseNumber === "doc-1") {
          return OUTCOMES.deferred;
        }
        return caseNumber === "doc-2" ? OUTCOMES.parked : OUTCOMES.filled;
      },
      polls: 3,
    });

    expect(run.summaries.at(0)).toMatchObject({
      attempted: 3,
      deferred: 1,
      parked: 1,
      filled: 1,
      failed: 0,
      failures: {
        "publisher-status": 1,
        network: 0,
        "too-large": 0,
        unparseable: 1,
      },
      lastFailureDetail: OUTCOMES.parked.detail,
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
      lastErrorDiagnostic: { kind: "unknown" },
    });
  });

  test("safe HTTP diagnostics belong only to their report window", async () => {
    const failure = Object.assign(new Error("private URL and response body"), {
      httpStatus: 429,
    });
    const run = await runDrain({
      queue: queueOf(["doc-1", "doc-2", "doc-3"]),
      respond: ({ caseNumber }) => {
        if (caseNumber === "doc-1") {
          throw failure;
        }
        return OUTCOMES.filled;
      },
      polls: 3,
      timing: { ...TIMING, summaryIntervalMs: 1 },
    });
    expect(run.summaries.at(0)?.lastErrorDiagnostic).toEqual({
      kind: "rate-limited",
      httpStatus: 429,
      httpStatusClass: "4xx",
    });
    expect(run.summaries).toHaveLength(2);
    expect(run.summaries.at(1)?.lastErrorDiagnostic).toBeUndefined();
  });
});
