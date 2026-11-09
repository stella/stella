import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  type ContinuationCodec,
  type ContinuationStore,
  createPublicReadContinuation,
  type PublicReadContinuationLimits,
} from "@/api/lib/legal-search/public-read-continuation";
import { isRecord } from "@/api/lib/type-guards";
import { createFakeContinuationStore as createFakeStore } from "@/api/tests/helpers/fake-continuation-store";

type Args = { query: string };
type Answer = { query: string; complete: boolean };
type Progress = { finished: number };

const codec: ContinuationCodec<Args, Answer, Progress> = {
  args: (value) =>
    isRecord(value) && typeof value["query"] === "string"
      ? { query: value["query"] }
      : null,
  result: (value) =>
    isRecord(value) &&
    typeof value["query"] === "string" &&
    typeof value["complete"] === "boolean"
      ? { query: value["query"], complete: value["complete"] }
      : null,
  progress: (value) =>
    isRecord(value) && typeof value["finished"] === "number"
      ? { finished: value["finished"] }
      : null,
};

const limits: PublicReadContinuationLimits = {
  leaseMs: 300,
  runBudgetMs: 2000,
  retentionMs: 60_000,
  incompleteRetentionMs: 5000,
  maxResultBytes: 1024 * 1024,
  maxAttempts: 3,
  perCallerConcurrency: 2,
  perCallerQueue: 50,
  processConcurrency: 16,
  processQueue: 200,
  followPollMs: 5,
  minRetryAfterMs: 100,
  maxRetryAfterMs: 5000,
};

// A run settles a race with this only by finishing; time moves in the store.
const neverElapses = async () =>
  await Promise.withResolvers<undefined>().promise;

const createInstance = (
  store: ContinuationStore,
  ownerId: string,
  overrides: Partial<PublicReadContinuationLimits> = {},
) =>
  createPublicReadContinuation<Args, Answer, Progress>({
    codec,
    store,
    ownerId,
    limits: { ...limits, ...overrides },
    now: () => 0,
    sleep: neverElapses,
  });

type WorkOptions = {
  id?: string;
  caller?: string;
  scope?: string;
  run?: (args: Args) => Promise<Answer>;
  isOverload?: (error: unknown) => boolean;
};

const workFor = ({
  id = "work-1",
  caller = "caller-1",
  scope = "org-1",
  run = async (args) => ({ query: args.query, complete: true }),
  isOverload = () => false,
}: WorkOptions = {}) => ({
  workId: id,
  caller,
  scope,
  args: { query: id },
  run: async (args: Args) => Result.ok(await run(args)),
  isOverload,
  judge: ({ complete }: Answer) =>
    complete ? { type: "complete" as const } : { type: "incomplete" as const },
});

const deferred = () => Promise.withResolvers<undefined>();

describe("public read continuation", () => {
  test("a read inside the deadline answers normally and stores nothing", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a");
    expect(
      await instance.attach({
        work: workFor(),
        via: "call",
        responseDeadlineMs: 1000,
      }),
    ).toEqual({
      status: "finished",
      result: { query: "work-1", complete: true },
    });
    expect(Result.unwrap(await store.readSpec("work-1"))).toBeNull();
    expect(Result.unwrap(await store.readFinished("work-1"))).toBeNull();
  });

  test("N identical calls against a slow read run it once and none fail", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a");
    const gate = deferred();
    let runs = 0;
    const work = workFor({
      run: async (args) => {
        runs += 1;
        await gate.promise;
        return { query: args.query, complete: true };
      },
    });
    const calls = await Promise.all(
      Array.from(
        { length: 25 },
        async () =>
          await instance.attach({
            work,
            via: "call",
            responseDeadlineMs: 0,
          }),
      ),
    );
    expect(runs).toBe(1);
    expect(calls.map(({ status }) => status)).toEqual(
      Array.from({ length: 25 }, () => "running"),
    );
    gate.resolve(undefined);
    const final = await instance.attach({
      work,
      via: "call",
      responseDeadlineMs: 1000,
    });
    expect(final.status).toBe("finished");
    expect(runs).toBe(1);
  });

  test("N distinct calls past every limit all end in a result or a continuation", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a", {
      perCallerConcurrency: 2,
      perCallerQueue: 4,
      processConcurrency: 4,
      processQueue: 8,
    });
    const gate = deferred();
    const calls = await Promise.all(
      Array.from(
        { length: 60 },
        async (_, index) =>
          await instance.attach({
            work: workFor({
              id: `work-${String(index)}`,
              caller: `caller-${String(index % 3)}`,
              run: async (args) => {
                await gate.promise;
                return { query: args.query, complete: true };
              },
            }),
            via: "call",
            responseDeadlineMs: 0,
          }),
      ),
    );
    gate.resolve(undefined);
    for (const outcome of calls) {
      expect(["running", "finished"]).toContain(outcome.status);
    }
    const phases = calls.flatMap((outcome) =>
      outcome.status === "running" ? [outcome.phase] : [],
    );
    expect(phases).toContain("not_started");
    expect(phases).toContain("queued");
    expect(phases).toContain("running");
  });

  test("one noisy caller queues behind its own limit while another runs at once", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a", {
      perCallerConcurrency: 1,
      processConcurrency: 8,
    });
    const gate = deferred();
    const started: string[] = [];
    const run = async (args: Args) => {
      started.push(args.query);
      await gate.promise;
      return { query: args.query, complete: true };
    };
    await Promise.all(
      ["n1", "n2", "n3"].map(
        async (id) =>
          await instance.attach({
            work: workFor({ id, caller: "noisy", run }),
            via: "call",
            responseDeadlineMs: 0,
          }),
      ),
    );
    const quiet = await instance.attach({
      work: workFor({ id: "q1", caller: "quiet", run }),
      via: "call",
      responseDeadlineMs: 0,
    });
    expect(started).toEqual(["n1", "q1"]);
    expect(quiet).toMatchObject({ status: "running", phase: "running" });
    gate.resolve(undefined);
  });

  test("a token resolves on another instance", async () => {
    const { store } = createFakeStore();
    const owner = createInstance(store, "a");
    const other = createInstance(store, "b");
    const gate = deferred();
    const work = workFor({
      run: async (args) => {
        await gate.promise;
        return { query: args.query, complete: true };
      },
    });
    const first = await owner.attach({
      work,
      via: "call",
      responseDeadlineMs: 0,
    });
    if (first.status !== "running") {
      throw new Error(`expected running, got ${first.status}`);
    }
    expect(await other.resolveToken(first.token, "org-1")).toEqual({
      status: "resolved",
      args: { query: "work-1" },
    });
    // While the owner works, the other instance follows rather than runs it.
    let otherRuns = 0;
    const follow = await other.attach({
      work: {
        ...work,
        run: async () => {
          otherRuns += 1;
          return Result.ok({ query: "x", complete: true });
        },
      },
      via: "token",
      responseDeadlineMs: 0,
    });
    expect(follow.status).toBe("running");
    expect(otherRuns).toBe(0);
    gate.resolve(undefined);
    await owner.attach({ work, via: "token", responseDeadlineMs: 1000 });
    expect(
      await other.attach({ work, via: "token", responseDeadlineMs: 1000 }),
    ).toEqual({
      status: "finished",
      result: { query: "work-1", complete: true },
    });
  });

  test("a token resolves only inside the account it was issued to", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a");
    const gate = deferred();
    await instance.attach({
      work: workFor({
        scope: "org-1",
        run: async (args) => {
          await gate.promise;
          return { query: args.query, complete: true };
        },
      }),
      via: "call",
      responseDeadlineMs: 0,
    });
    gate.resolve(undefined);
    expect(await instance.resolveToken("work-1", "org-1")).toMatchObject({
      status: "resolved",
    });
    expect(await instance.resolveToken("work-1", "org-2")).toEqual({
      status: "unknown",
    });
    expect(await instance.resolveToken("never-issued", "org-1")).toEqual({
      status: "unknown",
    });
  });

  test("when the owner dies the next call runs the work again", async () => {
    const { store, advance } = createFakeStore();
    // The dead task's heartbeat stops with it.
    store.renewLease = async () => Result.ok(false);
    const dead = createInstance(store, "dead", { leaseMs: 40 });
    const survivor = createInstance(store, "live", { leaseMs: 40 });
    // The dead task's read never returns and it stops renewing.
    const never = Promise.withResolvers<Answer>().promise;
    await dead.attach({
      work: workFor({ run: async () => await never }),
      via: "call",
      responseDeadlineMs: 0,
    });
    advance(60);
    let runs = 0;
    const recovered = await survivor.attach({
      work: workFor({
        run: async (args) => {
          runs += 1;
          return { query: args.query, complete: true };
        },
      }),
      via: "token",
      responseDeadlineMs: 1000,
    });
    expect(recovered).toEqual({
      status: "finished",
      result: { query: "work-1", complete: true },
    });
    expect(runs).toBe(1);
  });

  test("an incomplete answer serves its token but not a fresh identical call", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a");
    let runs = 0;
    const gate = deferred();
    const work = workFor({
      run: async (args) => {
        runs += 1;
        await gate.promise;
        return { query: args.query, complete: runs > 1 };
      },
    });
    const first = await instance.attach({
      work,
      via: "call",
      responseDeadlineMs: 0,
    });
    expect(first.status).toBe("running");
    gate.resolve(undefined);
    expect(
      await instance.attach({ work, via: "token", responseDeadlineMs: 1000 }),
    ).toEqual({
      status: "finished",
      result: { query: "work-1", complete: false },
    });
    expect(runs).toBe(1);
    const fresh = await instance.attach({
      work,
      via: "call",
      responseDeadlineMs: 1000,
    });
    expect(fresh).toEqual({
      status: "finished",
      result: { query: "work-1", complete: true },
    });
    expect(runs).toBe(2);
  });

  test("an overloaded run retries on the next call, then gives up honestly", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a", { maxAttempts: 2 });
    let runs = 0;
    const work = workFor({
      isOverload: () => true,
      run: async () => {
        runs += 1;
        throw new Error("queue full");
      },
    });
    const attempt = async () =>
      await instance.attach({ work, via: "call", responseDeadlineMs: 1000 });
    expect((await attempt()).status).toBe("running");
    expect((await attempt()).status).toBe("running");
    expect(runs).toBe(2);
    expect(await attempt()).toEqual({ status: "exhausted", token: "work-1" });
    expect(runs).toBe(2);
  });

  test("a failure load does not explain reaches the caller", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a");
    const failure = new Error("defect");
    const outcome = await instance.attach({
      work: workFor({
        run: async () => {
          throw failure;
        },
      }),
      via: "call",
      responseDeadlineMs: 1000,
    });
    expect(outcome).toEqual({ status: "failed", error: failure });
  });

  test("with the store down, the work still answers on its own task", async () => {
    const { store, setAvailable } = createFakeStore();
    setAvailable(false);
    const instance = createInstance(store, "a");
    expect(
      await instance.attach({
        work: workFor(),
        via: "call",
        responseDeadlineMs: 1000,
      }),
    ).toEqual({
      status: "finished",
      result: { query: "work-1", complete: true },
    });
  });

  test("an answer too large to store is still returned to whoever waits", async () => {
    const { store } = createFakeStore();
    const instance = createInstance(store, "a", { maxResultBytes: 10 });
    const gate = deferred();
    const work = workFor({
      run: async (args) => {
        await gate.promise;
        return { query: args.query, complete: true };
      },
    });
    await instance.attach({ work, via: "call", responseDeadlineMs: 0 });
    const waiting = instance.attach({
      work,
      via: "call",
      responseDeadlineMs: 1000,
    });
    gate.resolve(undefined);
    expect((await waiting).status).toBe("finished");
    expect(Result.unwrap(await store.readFinished("work-1"))).toBeNull();
  });

  test("a stored answer that no longer parses reads as absent", async () => {
    const { store } = createFakeStore();
    await store.writeFinished("work-1", "{not json", 1000);
    const instance = createInstance(store, "a");
    let runs = 0;
    const outcome = await instance.attach({
      work: workFor({
        run: async (args) => {
          runs += 1;
          return { query: args.query, complete: true };
        },
      }),
      via: "call",
      responseDeadlineMs: 1000,
    });
    expect(outcome.status).toBe("finished");
    expect(runs).toBe(1);
  });
});
