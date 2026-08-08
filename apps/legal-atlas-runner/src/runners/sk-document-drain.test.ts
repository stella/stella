/**
 * The walk's throughput is its sleep policy, and a wrong one is silent:
 * bursting looks like a healthy walk to everything except the publisher
 * being fetched from, and a loop that stops after the first failure
 * looks exactly like an empty queue. Both are pinned here.
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
  | { type: "fetch"; caseNumber: string }
  | { type: "sleep"; ms: number };

type DrainRun = {
  events: DrainEvent[];
  summaries: SkDocumentDrainSummary[];
};

type RunDrainOptions = {
  queue: PendingDocumentQueue;
  /** Answers one fetch; throwing stands in for a transient failure. */
  respond: (decision: PendingDocument) => DecisionDocumentOutcome;
  /** Iterations to let run before the walk is asked to drain. */
  iterations: number;
  timing?: SkDocumentDrainTiming;
};

const runDrain = async ({
  iterations,
  queue,
  respond,
  timing = TIMING,
}: RunDrainOptions): Promise<DrainRun> => {
  const events: DrainEvent[] = [];
  const summaries: SkDocumentDrainSummary[] = [];
  let clock = 0;
  let slept = 0;
  let draining = false;

  await runSkDocumentDrain({
    queue,
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
      slept += 1;
      draining = slept >= iterations;
      await Promise.resolve();
    },
    timing,
  });

  return { events, summaries };
};

/** Sleeps recorded between one fetch and the next. */
const gapsBetweenFetches = ({ events }: DrainRun): number[] => {
  const gaps: number[] = [];
  let sinceFetch: number | undefined;
  for (const event of events) {
    if (event.type === "fetch") {
      if (sinceFetch !== undefined) {
        gaps.push(sinceFetch);
      }
      sinceFetch = 0;
      continue;
    }
    if (sinceFetch !== undefined) {
      sinceFetch += event.ms;
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
      iterations: OUTCOME_STATUSES.length,
    });

    expect(run.events.filter(({ type }) => type === "fetch")).toHaveLength(
      OUTCOME_STATUSES.length,
    );
    expect(gapsBetweenFetches(run)).toEqual(
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
      iterations: 3,
    });

    // The walk carried on past the throw...
    expect(
      run.events.flatMap((event) =>
        event.type === "fetch" ? [event.caseNumber] : [],
      ),
    ).toEqual(["doc-1", "doc-2", "doc-3"]);
    // ...and paid for it, rather than retrying at full speed.
    expect(gapsBetweenFetches(run).at(0)).toBeGreaterThan(TIMING.fetchDelayMs);
  });

  test("a run of failures backs off to the ceiling and no further", async () => {
    const run = await runDrain({
      queue: queueOf(Array.from({ length: 12 }, (_, i) => `doc-${i}`)),
      respond: () => {
        throw new Error("unreachable");
      },
      iterations: 12,
    });

    const sleeps = run.events.flatMap((event) =>
      event.type === "sleep" ? [event.ms] : [],
    );
    const notIncreasing = sleeps.filter(
      (ms, i) => i > 0 && ms < (sleeps[i - 1] ?? 0),
    );

    expect(notIncreasing).toEqual([]);
    expect(sleeps.at(0)).toBe(TIMING.fetchDelayMs * 2);
    expect(sleeps.at(-1)).toBe(TIMING.failureBackoffMaxMs);
  });

  test("an empty queue backs off instead of polling at the fetch rate", async () => {
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      iterations: 5,
    });

    expect(run.events.filter(({ type }) => type === "fetch")).toEqual([]);
    expect(
      run.events.flatMap((event) => (event.type === "sleep" ? [event.ms] : [])),
    ).toEqual([1000, 2000, 4000, 8000, 8000]);
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
      iterations: 4,
    });

    expect(
      run.events.flatMap((event) => (event.type === "sleep" ? [event.ms] : [])),
    ).toEqual([1000, 2000, TIMING.fetchDelayMs, TIMING.fetchDelayMs]);
  });

  test("the summary tallies the window and is emitted once per interval", async () => {
    const run = await runDrain({
      queue: queueOf(["doc-1", "doc-2", "doc-3"]),
      respond: ({ caseNumber }) =>
        caseNumber === "doc-2" ? OUTCOMES.unavailable : OUTCOMES.filled,
      iterations: 3,
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

  test("an idle window reports nothing at all", async () => {
    // Progress and error rate are the signal; a stream of zero-rows
    // summaries would bury both. Liveness is the daemon's heartbeat.
    const run = await runDrain({
      queue: queueOf([]),
      respond: () => OUTCOMES.filled,
      iterations: 30,
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
      iterations: 1,
    });

    expect(run.summaries.at(0)).toMatchObject({
      attempted: 1,
      failed: 1,
      lastError: failure,
    });
  });
});
