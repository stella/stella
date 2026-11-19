import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";

import {
  createCorpusSearchAdmission,
  runAsCorpusSearchCaller,
  runInCorpusSearchLane,
  runWithPatientCorpusReads,
} from "@/api/lib/legal-search/corpus-index-admission";
import {
  CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { runWithPublicReadStatementTimeout } from "@/api/lib/legal-search/public-read-timeout-context";
import { LIMITS } from "@/api/lib/limits";
import {
  findRequestBudgetExpiry,
  runWithinRequestLatencyBudget,
} from "@/api/lib/load/request-latency-budget";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();
const originalFetch = globalThis.fetch;

afterEach(() => {
  testFetchState.restore();
});

/** A wait limit no test reaches. */
const unbounded = (): AbortSignal => new AbortController().signal;

const admitted = async (
  admission: ReturnType<typeof createCorpusSearchAdmission>,
): Promise<() => void> => {
  const result = await admission.acquire({ waitLimit: unbounded() });
  return result.type === "admitted"
    ? result.release
    : panic(`Expected admission, got ${result.reason}`);
};

test("a request's earlier phrasing is admitted before its later ones, and an older request before both", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const order: string[] = [];
  const queue = async (name: string, lane: number): Promise<void> =>
    await runInCorpusSearchLane(lane, async () => {
      const result = await admission.acquire({ waitLimit: unbounded() });
      order.push(name);
      if (result.type === "admitted") {
        queueMicrotask(result.release);
      }
    });
  // The older request, still waiting on its last phrasing.
  const older = runWithinRequestLatencyBudget(
    { label: "older", budgetMs: 8000, startedAtMs: performance.now() - 1000 },
    async () => await queue("older lane 4", 4),
  );
  const newer = runWithinRequestLatencyBudget(
    { label: "newer", budgetMs: 8000 },
    async () =>
      await Promise.all([
        queue("newer lane 2", 2),
        queue("newer lane 0", 0),
        queue("newer lane 1", 1),
      ]),
  );
  held();
  await Promise.all([older, newer]);
  expect(order).toEqual([
    "older lane 4",
    "newer lane 0",
    "newer lane 1",
    "newer lane 2",
  ]);
});

test("a queued read whose wait limit fires is refused as expired and leaves the queue", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const waitLimit = AbortSignal.timeout(5); // timeout under test
  const refused = await admission.acquire({ waitLimit });
  expect(refused).toMatchObject({ type: "refused", reason: "expired" });
  expect(admission.stats()).toMatchObject({ inFlight: 1, queued: 0 });
  held();
  expect(admission.stats()).toMatchObject({ inFlight: 0, queued: 0 });
});

test("a caller's cancel is told apart from the wait limit", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const controller = new AbortController();
  const waiting = admission.acquire({
    waitLimit: unbounded(),
    signal: controller.signal,
  });
  controller.abort(new Error("caller left"));
  expect(await waiting).toMatchObject({ type: "refused", reason: "aborted" });
  held();
});

test("a full queue refuses at once instead of queueing", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1, maxWaiters: 1 });
  const held = await admitted(admission);
  const controller = new AbortController();
  const queued = admission.acquire({
    waitLimit: unbounded(),
    signal: controller.signal,
  });
  expect(await admission.acquire({ waitLimit: unbounded() })).toMatchObject({
    type: "refused",
    reason: "busy",
    queued: 1,
  });
  controller.abort(new Error("done"));
  await queued;
  held();
});

const searchOnce = async () =>
  await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

test("a burst of searches reaches the engine no more than the process's slots at a time, and every one answers", async () => {
  const burst = LIMITS.corpusIndexSearchConcurrency * 4;
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const held: (() => void)[] = [];
  testFetchState.set(
    Object.assign(
      async () => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const { promise, resolve } = Promise.withResolvers<undefined>();
        held.push(() => {
          resolve(undefined);
        });
        // The engine holds every read open until as many are in flight as
        // admission allows (or the burst has all started), so an unbounded
        // client would show its whole burst at once.
        if (
          inFlight >= LIMITS.corpusIndexSearchConcurrency ||
          started === burst
        ) {
          for (const release of held.splice(0)) {
            release();
          }
        }
        await promise;
        inFlight -= 1;
        return Response.json({ num_hits: 0, hits: [], snippets: [] });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const results = await Promise.all(
    Array.from({ length: burst }, async () => await searchOnce()),
  );
  expect(results.filter((result) => result.isOk())).toHaveLength(burst);
  expect(peak).toBe(LIMITS.corpusIndexSearchConcurrency);
});

test("a search queued past its request's budget fails as the budget's timeout without reaching the engine", async () => {
  const sent: string[] = [];
  const gates: (() => void)[] = [];
  testFetchState.set(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push(typeof init?.body === "string" ? init.body : "");
        // Hold every slot until the queued search has given up.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return Response.json({ num_hits: 0, hits: [], snippets: [] });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const holders = Array.from(
    { length: LIMITS.corpusIndexSearchConcurrency },
    async () => await searchOnce(),
  );
  const budgetMs = 30; // timeout under test: the request's whole budget
  const queued = await runWithinRequestLatencyBudget(
    { label: "search_case_law", budgetMs },
    async () => await searchOnce(),
  );
  expect(sent).toHaveLength(LIMITS.corpusIndexSearchConcurrency);
  for (const release of gates) {
    release();
  }
  await Promise.all(holders);
  const failure = queued.isErr()
    ? queued.error
    : panic("Expected the queued search to run out of its budget");
  expect(failure).toBeInstanceOf(CorpusIndexError);
  expect(failure.reach).toBe("budget_expired");
  expect(findRequestBudgetExpiry(failure)).toMatchObject({
    label: "search_case_law",
  });
});

test("a search queued under a public-read scope leaves the queue when the scope ends", async () => {
  const gates: (() => void)[] = [];
  let sent = 0;
  testFetchState.set(
    Object.assign(
      async () => {
        sent += 1;
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return Response.json({ num_hits: 0, hits: [], snippets: [] });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const holders = Array.from(
    { length: LIMITS.corpusIndexSearchConcurrency },
    async () => await searchOnce(),
  );
  const lease = new AbortController();
  const queued = runWithPublicReadStatementTimeout(
    { budgetMs: 8000, signal: lease.signal },
    async () => await searchOnce(),
  );
  lease.abort(new Error("public-read lease lost"));
  const result = await queued;
  expect(result.isErr()).toBe(true);
  expect(sent).toBe(LIMITS.corpusIndexSearchConcurrency);
  for (const release of gates) {
    release();
  }
  await Promise.all(holders);
});

test("a read admitted without queueing reports no wait, however late it resumes", async () => {
  // Every reading of the clock is later than the last, as when other work
  // delays the read's continuation.
  let ms = 0;
  const admission = createCorpusSearchAdmission({
    now: () => (ms += 5),
    slots: 1,
  });
  const result = await admission.acquire({ waitLimit: unbounded() });
  const read =
    result.type === "admitted"
      ? result
      : panic(`Expected admission, got ${result.reason}`);
  read.release();
  expect(read.waitedMs).toBe(0);
});

test("one caller's backlog does not delay another caller's first read", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const order: string[] = [];
  const read = async (caller: string, name: string): Promise<void> =>
    await runAsCorpusSearchCaller(caller, async () => {
      const result = await admission.acquire({ waitLimit: unbounded() });
      order.push(name);
      if (result.type === "admitted") {
        queueMicrotask(result.release);
      }
    });
  const backlog = Array.from(
    { length: 6 },
    async (_, index) => await read("noisy", `noisy-${String(index)}`),
  );
  // Queued after the whole backlog, but its turn comes before the backlog's tail.
  const quiet = read("quiet", "quiet");
  await Promise.resolve();
  held();
  await Promise.all([...backlog, quiet]);
  expect(order.indexOf("quiet")).toBeLessThan(order.indexOf("noisy-2"));
  // Each caller's own reads still keep their arrival order.
  const noisy = order.filter((name) => name.startsWith("noisy"));
  expect(noisy).toEqual(noisy.toSorted());
});

test("reads with no caller keep the plain request order", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const order: string[] = [];
  const read = async (name: string, lane: number): Promise<void> =>
    await runInCorpusSearchLane(lane, async () => {
      const result = await admission.acquire({ waitLimit: unbounded() });
      order.push(name);
      if (result.type === "admitted") {
        queueMicrotask(result.release);
      }
    });
  // Two reads of one request, so the lane is what tells them apart.
  const reads = runWithinRequestLatencyBudget(
    { label: "one-request", budgetMs: 60_000, startedAtMs: 1 },
    () => [read("late", 1), read("early", 0)],
  );
  await Promise.resolve();
  held();
  await Promise.all(reads);
  expect(order).toEqual(["early", "late"]);
});

test("a read the queue estimates cannot start in time is refused at once", async () => {
  let clock = 0;
  const admission = createCorpusSearchAdmission({
    slots: 1,
    now: () => clock,
  });
  // Teach the queue reads take a second each.
  for (let index = 0; index < 8; index++) {
    const release = await admitted(admission);
    clock += 1000;
    release();
  }
  const held = await admitted(admission);
  const queued = admission.acquire({ waitLimit: unbounded() });
  await Promise.resolve();
  expect(admission.estimatedWaitMs()).toBeGreaterThan(1000);

  const refused = await admission.acquire({
    waitLimit: unbounded(),
    maxWaitMs: 500,
  });
  expect(refused).toMatchObject({
    type: "refused",
    reason: "deadline",
    waitedMs: 0,
  });

  // With time to spare it queues as usual.
  const patient = admission.acquire({
    waitLimit: unbounded(),
    maxWaitMs: 60_000,
  });
  await Promise.resolve();
  expect(admission.stats().queued).toBe(2);
  held();
  const first = await queued;
  if (first.type === "admitted") {
    first.release();
  }
  const second = await patient;
  if (second.type === "admitted") {
    second.release();
  }
});

test("an unmeasured queue never refuses for its estimate", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1 });
  const held = await admitted(admission);
  const queued = admission.acquire({ waitLimit: unbounded(), maxWaitMs: 1 });
  await Promise.resolve();
  expect(admission.stats().queued).toBe(1);
  held();
  const result = await queued;
  if (result.type === "admitted") {
    result.release();
  }
});

test("a patient read waits out a full queue where another is refused", async () => {
  const admission = createCorpusSearchAdmission({ slots: 1, maxWaiters: 1 });
  const held = await admitted(admission);
  const queued = admission.acquire({ waitLimit: unbounded() });
  await Promise.resolve();

  expect(await admission.acquire({ waitLimit: unbounded() })).toMatchObject({
    type: "refused",
    reason: "busy",
  });

  const patient = runWithPatientCorpusReads(
    async () => await admission.acquire({ waitLimit: unbounded() }),
  );
  held();
  const first = await queued;
  if (first.type === "admitted") {
    first.release();
  }
  const admittedPatient = await patient;
  expect(admittedPatient.type).toBe("admitted");
  if (admittedPatient.type === "admitted") {
    admittedPatient.release();
  }
});
