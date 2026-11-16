import { panic, Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Overload continuation for public-law reads.
 *
 * A read that cannot answer inside its response deadline does not time out:
 * the caller gets an ordinary result saying the work is still running, and a
 * token. The work carries on detached from the request and its answer is
 * stored, so a later call on any API task collects it. An identical call
 * attaches to the same work instead of starting more.
 *
 * Ownership is a lease in the coordination store. A task that dies stops
 * renewing its lease, and the next call that finds no answer and no lease runs
 * the work again: a public read is deterministic, so running it twice costs
 * time and changes nothing. The store holds only what the request can
 * reproduce. When it is unreachable the work still runs and answers on this
 * task, and a later call on another task runs it again.
 *
 * Bounded three ways: per-caller and process-wide concurrency with bounded
 * queues, a time budget per run, and a size and TTL on what is stored. Past
 * the bounds the work is shed: the caller is told nothing started and when to
 * call again, and after repeated failures it gets a terminal outcome rather
 * than an endless promise. Nothing here reports a read as finished unless it
 * finished.
 */

export type ContinuationStoreError = { type: "unavailable"; cause: unknown };

type StoreResult<T> = Promise<Result<T, ContinuationStoreError>>;

export type ContinuationStore = {
  readSpec: (workId: string) => StoreResult<string | null>;
  writeSpec: (workId: string, spec: string, ttlMs: number) => StoreResult<void>;
  readFinished: (workId: string) => StoreResult<string | null>;
  writeFinished: (
    workId: string,
    finished: string,
    ttlMs: number,
  ) => StoreResult<void>;
  readProgress: (workId: string) => StoreResult<string | null>;
  writeProgress: (
    workId: string,
    progress: string,
    ttlMs: number,
  ) => StoreResult<void>;
  /** Whether `owner` now holds the lease; held by anyone else is `false`. */
  acquireLease: (
    workId: string,
    owner: string,
    ttlMs: number,
  ) => StoreResult<boolean>;
  /** `false` when `owner` no longer holds it. */
  renewLease: (
    workId: string,
    owner: string,
    ttlMs: number,
  ) => StoreResult<boolean>;
  releaseLease: (workId: string, owner: string) => StoreResult<void>;
  /** Count one more run of this work, returning the runs so far. */
  countAttempt: (workId: string, ttlMs: number) => StoreResult<number>;
  clearAttempts: (workId: string) => StoreResult<void>;
};

export type PublicReadContinuationLimits = {
  leaseMs: number;
  /** How long a run may take, detached from any request. */
  runBudgetMs: number;
  /** How long a spec, an answer and an attempt count live. */
  retentionMs: number;
  /** An incomplete answer serves its token, and only briefly. */
  incompleteRetentionMs: number;
  maxResultBytes: number;
  maxAttempts: number;
  perCallerConcurrency: number;
  perCallerQueue: number;
  processConcurrency: number;
  processQueue: number;
  followPollMs: number;
  minRetryAfterMs: number;
  maxRetryAfterMs: number;
};

/** How a finished run's value reads: only `complete` may serve a new call. */
export type ContinuationRunVerdict =
  | { type: "complete" }
  /** Honest but shaped by load: served to the token that asked, then dropped. */
  | { type: "incomplete" }
  /** Overloaded: nothing to keep; the next call runs it again. */
  | { type: "overloaded" };

export type ContinuationPhase = "queued" | "running" | "not_started";

export type ContinuationOutcome<R, P> =
  | { status: "finished"; result: R }
  | {
      status: "running";
      token: string;
      retryAfterMs: number;
      phase: ContinuationPhase;
      progress: P | null;
    }
  /** Repeated runs ended without an answer; do not promise another. */
  | { status: "exhausted"; token: string }
  /** The run failed for a reason load does not explain. */
  | { status: "failed"; error: unknown };

type RunContext<P> = {
  signal: AbortSignal;
  reportProgress: (progress: P) => void;
};

export type ContinuationWork<A, R, P> = {
  workId: string;
  /** Who the work is charged to, for concurrency. */
  caller: string;
  /** The account the work belongs to; a token only resolves inside it. */
  scope: string;
  args: A;
  /** An error here is the run's own failure; `isOverload` reads it. */
  run: (args: A, context: RunContext<P>) => Promise<Result<R, unknown>>;
  /** Whether a thrown failure is load rather than a defect. */
  isOverload: (error: unknown) => boolean;
  judge: (result: R) => ContinuationRunVerdict;
};

type JobOutcome<R> =
  | { type: "finished"; result: R }
  | { type: "overloaded" }
  | { type: "failed"; error: unknown };

type LeaseHold = {
  /** Aborts when the store confirms another task now owns this work. */
  signal: AbortSignal;
  lost: () => boolean;
  stop: () => void;
};

type Job<R, P> = {
  phase: "queued" | "running";
  progress: P | null;
  /** A caller on this task holds a token, so the answer must be stored. */
  tokenIssued: boolean;
  lease: LeaseHold;
  settled: Promise<JobOutcome<R>>;
};

type StoredFinished<R> = { complete: boolean; result: R };
type StoredSpec<A> = { scope: string; args: A };

type GateEntry = { caller: string; start: () => void };

/**
 * Per-caller and process-wide concurrency. A slot that frees goes to the
 * oldest waiter whose caller is under its own limit, so a caller with a long
 * queue cannot hold back one with none.
 */
const createWorkGate = (
  limits: Pick<
    PublicReadContinuationLimits,
    | "perCallerConcurrency"
    | "perCallerQueue"
    | "processConcurrency"
    | "processQueue"
  >,
) => {
  const active = new Map<string, number>();
  const queued = new Map<string, number>();
  const waiting: GateEntry[] = [];
  let totalActive = 0;

  const activeOf = (caller: string) => active.get(caller) ?? 0;
  const queuedOf = (caller: string) => queued.get(caller) ?? 0;

  const take = (caller: string) => {
    active.set(caller, activeOf(caller) + 1);
    totalActive += 1;
  };

  const drain = () => {
    while (totalActive < limits.processConcurrency) {
      const index = waiting.findIndex(
        ({ caller }) => activeOf(caller) < limits.perCallerConcurrency,
      );
      const next = index === -1 ? undefined : waiting.splice(index, 1).at(0);
      if (next === undefined) {
        return;
      }
      const remaining = queuedOf(next.caller) - 1;
      if (remaining === 0) {
        queued.delete(next.caller);
      } else {
        queued.set(next.caller, remaining);
      }
      take(next.caller);
      next.start();
    }
  };

  const release = (caller: string) => {
    const remaining = activeOf(caller) - 1;
    if (remaining === 0) {
      active.delete(caller);
    } else {
      active.set(caller, remaining);
    }
    totalActive -= 1;
    drain();
  };

  const canAdmit = (caller: string): boolean =>
    (totalActive < limits.processConcurrency &&
      activeOf(caller) < limits.perCallerConcurrency) ||
    (waiting.length < limits.processQueue &&
      queuedOf(caller) < limits.perCallerQueue);

  /** Run at once, queue, or refuse: the caller decides what a refusal means. */
  const enter = (
    caller: string,
    start: () => void,
  ): "started" | "queued" | "refused" => {
    if (
      totalActive < limits.processConcurrency &&
      activeOf(caller) < limits.perCallerConcurrency
    ) {
      take(caller);
      start();
      return "started";
    }
    if (
      waiting.length >= limits.processQueue ||
      queuedOf(caller) >= limits.perCallerQueue
    ) {
      return "refused";
    }
    waiting.push({ caller, start });
    queued.set(caller, queuedOf(caller) + 1);
    return "queued";
  };

  return {
    canAdmit,
    enter,
    release,
    backlog: () => totalActive + waiting.length,
    concurrency: limits.processConcurrency,
  };
};

/**
 * Reads what the store hands back. The store is a trust boundary of its own
 * (another release may have written it), so a value that does not parse reads
 * as absent and the work simply runs again.
 */
export type ContinuationCodec<A, R, P> = {
  args: (value: unknown) => A | null;
  result: (value: unknown) => R | null;
  progress: (value: unknown) => P | null;
};

type CreatePublicReadContinuationOptions<A, R, P> = {
  codec: ContinuationCodec<A, R, P>;
  store: ContinuationStore;
  ownerId: string;
  limits: PublicReadContinuationLimits;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The expected wait for a read slot right now, or 0 when unknown. */
  estimateQueueWaitMs?: () => number;
  /** Failures of the store itself; never surfaced to a caller. */
  onStoreError?: (operation: string, error: ContinuationStoreError) => void;
};

type AttachOptions<A, R, P> = {
  work: ContinuationWork<A, R, P>;
  /** Set when the caller presented a token rather than a fresh call. */
  via: "call" | "token";
  responseDeadlineMs: number;
};

type ResolveTokenResult<A> =
  | { status: "resolved"; args: A }
  /** Unknown, expired, or another account's: treated alike on purpose. */
  | { status: "unknown" };

const parseJson = (raw: string): unknown =>
  Result.try(() => {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  }).unwrapOr(null);

type Reported = <T>(
  operation: string,
  result: Result<T, ContinuationStoreError>,
) => T | undefined;

const LOCAL_FINISHED_MAX = 32;

/** How long a run may ignore its abort before its slot is taken back. */
const ABORT_GRACE_MS = 1000;

type FinishedAnswersOptions<R> = {
  decodeResult: (value: unknown) => R | null;
  store: ContinuationStore;
  limits: PublicReadContinuationLimits;
  now: () => number;
  reported: Reported;
  onStoreError: (operation: string, error: ContinuationStoreError) => void;
};

/** Finished answers, in the store or on this task when the store refused. */
const createFinishedAnswers = <R>({
  decodeResult,
  store,
  limits,
  now,
  reported,
  onStoreError,
}: FinishedAnswersOptions<R>) => {
  /** Answers the store refused, so this task can still serve its own token. */
  const localFinished = new Map<
    string,
    { json: string; expiresAtMs: number }
  >();

  const liveLocal = (workId: string): string | null => {
    const entry = localFinished.get(workId);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= now()) {
      localFinished.delete(workId);
      return null;
    }
    return entry.json;
  };

  const decodeFinished = (raw: string): StoredFinished<R> | null => {
    const parsed = parseJson(raw);
    if (!isRecord(parsed) || typeof parsed["complete"] !== "boolean") {
      return null;
    }
    const result = decodeResult(parsed["result"]);
    return result === null ? null : { complete: parsed["complete"], result };
  };

  const readFinished = async (
    workId: string,
  ): Promise<StoredFinished<R> | null> => {
    // The store first: a local answer is only what the store refused, and a
    // newer run may have written a better one since.
    const stored = reported("read_finished", await store.readFinished(workId));
    if (stored !== undefined && stored !== null) {
      localFinished.delete(workId);
      return decodeFinished(stored);
    }
    const local = liveLocal(workId);
    return local === null ? null : decodeFinished(local);
  };

  const keepFinished = async (
    workId: string,
    finished: StoredFinished<R>,
  ): Promise<"kept" | "too_large"> => {
    const json = JSON.stringify(finished);
    if (Buffer.byteLength(json) > limits.maxResultBytes) {
      return "too_large";
    }
    const ttlMs = finished.complete
      ? limits.retentionMs
      : limits.incompleteRetentionMs;
    const written = await store.writeFinished(workId, json, ttlMs);
    if (Result.isError(written)) {
      onStoreError("write_finished", written.error);
      localFinished.set(workId, { json, expiresAtMs: now() + ttlMs });
      if (localFinished.size > LOCAL_FINISHED_MAX) {
        const oldest = localFinished.keys().next();
        if (!oldest.done) {
          localFinished.delete(oldest.value);
        }
      }
    }
    return "kept";
  };

  return { readFinished, keepFinished };
};

/**
 * Settles once the run has ignored its abort for the grace period, so a stuck
 * promise cannot hold a slot and a lease for ever.
 */
const abandonAfterAbort = async (signal: AbortSignal) =>
  await new Promise<Result<never, "abandoned">>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        setTimeout(() => {
          resolve(Result.err("abandoned"));
        }, ABORT_GRACE_MS).unref();
      },
      { once: true },
    );
  });

type HoldLeaseOptions = {
  workId: string;
  store: ContinuationStore;
  ownerId: string;
  limits: PublicReadContinuationLimits;
  reported: Reported;
  /** False when the store was down at the start: there is no lease to lose. */
  leased: boolean;
};

/** Keep the lease alive from admission, queue time included, until stopped. */
const holdLease = ({
  workId,
  store,
  ownerId,
  limits,
  reported,
  leased,
}: HoldLeaseOptions): LeaseHold => {
  const controller = new AbortController();
  const heartbeat = setInterval(
    () => {
      detached(async () => {
        const renewed = reported(
          "renew_lease",
          await store.renewLease(workId, ownerId, limits.leaseMs),
        );
        // `undefined` is an unreachable store, which says nothing about who
        // owns the work.
        if (renewed === false && leased) {
          controller.abort();
        }
      }, "public-read-continuation.renew-lease");
    },
    Math.max(1, Math.floor(limits.leaseMs / 3)),
  );
  heartbeat.unref();
  return {
    signal: controller.signal,
    lost: () => controller.signal.aborted,
    stop: () => {
      clearInterval(heartbeat);
    },
  };
};

type RunContinuationJobOptions<A, R, P> = {
  work: ContinuationWork<A, R, P>;
  job: Job<R, P>;
  store: ContinuationStore;
  limits: PublicReadContinuationLimits;
  reported: Reported;
  keepFinished: (
    workId: string,
    finished: StoredFinished<R>,
  ) => Promise<"kept" | "too_large">;
  persistProgress: (workId: string, progress: P) => void;
};

/** Run the work once under its lease and budget, and keep what it found. */
const runContinuationJob = async <A, R, P>({
  work,
  job,
  store,
  limits,
  reported,
  keepFinished,
  persistProgress,
}: RunContinuationJobOptions<A, R, P>): Promise<JobOutcome<R>> => {
  /** Whether anyone, on any task, was promised this work's answer. */
  const someoneHoldsToken = async (): Promise<boolean> => {
    const spec = reported("read_spec", await store.readSpec(work.workId));
    return job.tokenIssued || (spec !== undefined && spec !== null);
  };

  // Lost while queued: the task that took the lease runs it.
  if (job.lease.lost()) {
    return { type: "overloaded" };
  }
  job.phase = "running";
  const controller = new AbortController();
  const budget = setTimeout(() => {
    controller.abort();
  }, limits.runBudgetMs);
  budget.unref();
  const signal = AbortSignal.any([controller.signal, job.lease.signal]);
  const reportProgress = (progress: P) => {
    job.progress = progress;
    if (job.tokenIssued) {
      persistProgress(work.workId, progress);
    }
  };
  const settled = await Promise.race([
    Result.tryPromise({
      try: async () => await work.run(work.args, { signal, reportProgress }),
      catch: (error) => error,
    }),
    abandonAfterAbort(signal),
  ]);
  const attempted = Result.isError(settled) ? settled : settled.value;
  clearTimeout(budget);
  // Another task owns this work now; what this run found must not replace it.
  if (job.lease.lost()) {
    return { type: "overloaded" };
  }
  if (Result.isError(attempted)) {
    return work.isOverload(attempted.error) || signal.aborted
      ? { type: "overloaded" }
      : { type: "failed", error: attempted.error };
  }
  const verdict = work.judge(attempted.value);
  if (verdict.type === "overloaded") {
    return { type: "overloaded" };
  }
  const kept = (await someoneHoldsToken())
    ? await keepFinished(work.workId, {
        complete: verdict.type === "complete",
        result: attempted.value,
      })
    : "kept";
  // An answer no token can collect must keep counting, or a token holder
  // would be told "running" forever.
  if (kept === "kept") {
    reported("clear_attempts", await store.clearAttempts(work.workId));
  }
  return { type: "finished", result: attempted.value };
};

type ResolveContinuationTokenOptions<A> = {
  token: string;
  scope: string;
  decodeArgs: (value: unknown) => A | null;
  store: ContinuationStore;
  reported: Reported;
};

/**
 * The arguments a token stands for, when it is one this account was issued.
 * An unreachable store reads as unknown: the caller is told to repeat the
 * call, which needs nothing from the store.
 */
const resolveContinuationToken = async <A>({
  token,
  scope,
  decodeArgs,
  store,
  reported,
}: ResolveContinuationTokenOptions<A>): Promise<ResolveTokenResult<A>> => {
  const raw = reported("read_spec", await store.readSpec(token));
  if (raw === undefined || raw === null) {
    return { status: "unknown" };
  }
  const spec = parseJson(raw);
  if (!isRecord(spec) || spec["scope"] !== scope) {
    return { status: "unknown" };
  }
  const args = decodeArgs(spec["args"]);
  return args === null ? { status: "unknown" } : { status: "resolved", args };
};

type StartContinuationJobOptions<A, R, P> = {
  work: ContinuationWork<A, R, P>;
  gate: ReturnType<typeof createWorkGate>;
  jobs: Map<string, Job<R, P>>;
  store: ContinuationStore;
  ownerId: string;
  limits: PublicReadContinuationLimits;
  reported: Reported;
  leased: boolean;
  runJob: (
    work: ContinuationWork<A, R, P>,
    job: Job<R, P>,
  ) => Promise<JobOutcome<R>>;
};

/**
 * Start the work under this task's lease, or say why it did not start. The
 * job's promise never rejects, so a run nobody waits for cannot surface as
 * an unhandled rejection.
 */
const startContinuationJob = async <A, R, P>({
  work,
  gate,
  jobs,
  store,
  ownerId,
  limits,
  reported,
  leased,
  runJob,
}: StartContinuationJobOptions<A, R, P>): Promise<
  Job<R, P> | "not_started" | "exhausted"
> => {
  const giveUp = async (
    outcome: "not_started" | "exhausted",
  ): Promise<"not_started" | "exhausted"> => {
    reported("release_lease", await store.releaseLease(work.workId, ownerId));
    return outcome;
  };
  // Before the attempt is counted: work shed for capacity never ran.
  if (!gate.canAdmit(work.caller)) {
    return await giveUp("not_started");
  }
  const attempts = reported(
    "count_attempt",
    await store.countAttempt(work.workId, limits.retentionMs),
  );
  if (attempts !== undefined && attempts > limits.maxAttempts) {
    return await giveUp("exhausted");
  }
  // With the store down nothing serialised the starts above.
  const raced = jobs.get(work.workId);
  if (raced !== undefined) {
    return raced;
  }
  const lease = holdLease({
    workId: work.workId,
    store,
    ownerId,
    limits,
    reported,
    leased,
  });
  let begin: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const job: Job<R, P> = {
    phase: "queued",
    progress: null,
    tokenIssued: false,
    lease,
    settled: started.then(async () => {
      const outcome = await runJob(work, job);
      lease.stop();
      if (jobs.get(work.workId) === job) {
        jobs.delete(work.workId);
      }
      gate.release(work.caller);
      // Not awaited: whoever waits on this job has its answer already.
      detached(async () => {
        reported(
          "release_lease",
          await store.releaseLease(work.workId, ownerId),
        );
      }, "public-read-continuation.release-lease");
      return outcome;
    }),
  };
  const admitted = gate.enter(work.caller, begin);
  if (admitted === "refused") {
    lease.stop();
    return await giveUp("not_started");
  }
  if (admitted === "started") {
    job.phase = "running";
  }
  jobs.set(work.workId, job);
  return job;
};

const suggestedRetryAfterMs = (
  gate: Pick<ReturnType<typeof createWorkGate>, "backlog" | "concurrency">,
  queueWaitMs: number,
  limits: PublicReadContinuationLimits,
): number =>
  Math.round(
    Math.min(
      limits.maxRetryAfterMs,
      Math.max(
        limits.minRetryAfterMs,
        queueWaitMs,
        (gate.backlog() / gate.concurrency) * limits.followPollMs * 4,
      ),
    ),
  );

const finishedOutcome = <R, P>(
  finished: StoredFinished<R> | null,
  via: "call" | "token",
): ContinuationOutcome<R, P> | null =>
  finished !== null && (finished.complete || via === "token")
    ? { status: "finished", result: finished.result }
    : null;

export const createPublicReadContinuation = <A, R, P>({
  codec,
  store,
  ownerId,
  limits,
  now,
  sleep,
  estimateQueueWaitMs = () => 0,
  onStoreError = () => undefined,
}: CreatePublicReadContinuationOptions<A, R, P>) => {
  const jobs = new Map<string, Job<R, P>>();
  const gate = createWorkGate(limits);
  const reported = <T>(
    operation: string,
    result: Result<T, ContinuationStoreError>,
  ): T | undefined => {
    if (Result.isError(result)) {
      onStoreError(operation, result.error);
      return undefined;
    }
    return result.value;
  };

  const { readFinished, keepFinished } = createFinishedAnswers({
    decodeResult: codec.result,
    store,
    limits,
    now,
    reported,
    onStoreError,
  });

  const persistProgress = (workId: string, progress: P): void => {
    detached(async () => {
      reported(
        "write_progress",
        await store.writeProgress(
          workId,
          JSON.stringify(progress),
          limits.retentionMs,
        ),
      );
    }, "public-read-continuation.write-progress");
  };

  /**
   * Tell the caller the work is still going. The spec is written here and not
   * at the start of the work, so a read that answers inside its deadline
   * leaves nothing behind in the store.
   */
  const running = async (
    work: ContinuationWork<A, R, P>,
    phase: ContinuationPhase,
    progress: P | null,
  ): Promise<ContinuationOutcome<R, P>> => {
    const job = jobs.get(work.workId);
    if (job !== undefined) {
      if (!job.tokenIssued && job.progress !== null) {
        persistProgress(work.workId, job.progress);
      }
      job.tokenIssued = true;
    }
    const spec: StoredSpec<A> = { scope: work.scope, args: work.args };
    reported(
      "write_spec",
      await store.writeSpec(
        work.workId,
        JSON.stringify(spec),
        limits.retentionMs,
      ),
    );
    return {
      status: "running",
      token: work.workId,
      retryAfterMs: suggestedRetryAfterMs(gate, estimateQueueWaitMs(), limits),
      phase,
      progress,
    };
  };

  const runJob = async (
    work: ContinuationWork<A, R, P>,
    job: Job<R, P>,
  ): Promise<JobOutcome<R>> =>
    await runContinuationJob({
      work,
      job,
      store,
      limits,
      reported,
      keepFinished,
      persistProgress,
    });

  const start = async (work: ContinuationWork<A, R, P>, leased: boolean) =>
    await startContinuationJob({
      work,
      gate,
      jobs,
      store,
      ownerId,
      limits,
      reported,
      leased,
      runJob,
    });

  const awaitJob = async (
    work: ContinuationWork<A, R, P>,
    job: Job<R, P>,
    deadlineAtMs: number,
  ): Promise<ContinuationOutcome<R, P>> => {
    const remainingMs = deadlineAtMs - now();
    const settled =
      remainingMs <= 0
        ? null
        : await Promise.race([
            job.settled,
            sleep(remainingMs).then(() => null),
          ]);
    if (settled === null) {
      return await running(work, job.phase, job.progress);
    }
    switch (settled.type) {
      case "finished":
        return { status: "finished", result: settled.result };
      case "overloaded":
        return await running(work, "not_started", job.progress);
      case "failed":
        return { status: "failed", error: settled.error };
      default:
        settled satisfies never;
        return panic("Unhandled continuation job outcome");
    }
  };

  const readProgress = async (workId: string): Promise<P | null> => {
    const stored = reported("read_progress", await store.readProgress(workId));
    return stored === undefined || stored === null
      ? null
      : codec.progress(parseJson(stored));
  };

  const startOrFollow = async (
    work: ContinuationWork<A, R, P>,
    via: "call" | "token",
    deadlineAtMs: number,
  ): Promise<ContinuationOutcome<R, P>> => {
    const { workId } = work;
    for (;;) {
      const local = jobs.get(workId);
      if (local !== undefined) {
        return await awaitJob(work, local, deadlineAtMs);
      }
      const lease = await store.acquireLease(workId, ownerId, limits.leaseMs);
      if (Result.isError(lease)) {
        onStoreError("acquire_lease", lease.error);
      }
      if (Result.isError(lease) || lease.value) {
        const job = await start(work, Result.isOk(lease));
        if (job === "exhausted") {
          return { status: "exhausted", token: workId };
        }
        if (job === "not_started") {
          return await running(work, "not_started", null);
        }
        // Deadline-aware: a queued job, or a queue that will not reach it in
        // time, is not worth holding the caller for.
        return job.phase === "queued" ||
          estimateQueueWaitMs() > deadlineAtMs - now()
          ? await running(work, job.phase, job.progress)
          : await awaitJob(work, job, deadlineAtMs);
      }
      const remainingMs = deadlineAtMs - now();
      if (remainingMs <= 0) {
        return await running(work, "running", await readProgress(workId));
      }
      await sleep(Math.min(limits.followPollMs, remainingMs));
      const answered = finishedOutcome<R, P>(await readFinished(workId), via);
      if (answered !== null) {
        return answered;
      }
    }
  };

  /** Join or start the work and answer within the response deadline. */
  const attach = async ({
    work,
    via,
    responseDeadlineMs,
  }: AttachOptions<A, R, P>): Promise<ContinuationOutcome<R, P>> => {
    const deadlineAtMs = now() + responseDeadlineMs;
    const { workId } = work;
    const local = jobs.get(workId);
    if (local !== undefined) {
      return await awaitJob(work, local, deadlineAtMs);
    }
    const answered = finishedOutcome<R, P>(await readFinished(workId), via);
    if (answered !== null) {
      return answered;
    }
    return await startOrFollow(work, via, deadlineAtMs);
  };

  const resolveToken = async (token: string, scope: string) =>
    await resolveContinuationToken({
      token,
      scope,
      decodeArgs: codec.args,
      store,
      reported,
    });

  return { attach, resolveToken };
};
