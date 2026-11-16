import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { waitFor } from "@stll/test-kit";

import {
  type ContinuationCodec,
  type ContinuationStore,
  createPublicReadContinuation,
  type PublicReadContinuationLimits,
} from "@/api/lib/legal-search/public-read-continuation";
import { createContinuationStore } from "@/api/lib/legal-search/public-read-continuation-store";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import { isRecord } from "@/api/lib/type-guards";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

// Generous on a shared CI node: one slow reply would open the store's breaker
// and fail every command after it for reasons no assertion here is about.
const COMMAND_TIMEOUT_MS = 2000;

const workId = () => `valkey-${Bun.randomUUIDv7()}`;

const leaseKey = (id: string) =>
  coordinationKey({
    scope: "public-read-continuation",
    slot: id,
    suffix: "lease",
  });

const unwrapped = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    return panic(`Store command failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/** A second connection, so assertions read the server and not the store. */
const withInspector = async (
  run: (inspect: {
    pttl: (key: string) => Promise<number>;
    get: (key: string) => Promise<unknown>;
  }) => Promise<void>,
) => {
  const client = createRedisClient({ storeClass: "cache" });
  await client.connect();
  try {
    await run({
      pttl: async (key) => Number(await client.send("PTTL", [key])),
      get: async (key): Promise<unknown> => await client.send("GET", [key]),
    });
  } finally {
    client.close();
  }
};

type Args = { query: string };
type Answer = { query: string };

const codec: ContinuationCodec<Args, Answer, null> = {
  args: (value) =>
    isRecord(value) && typeof value["query"] === "string"
      ? { query: value["query"] }
      : null,
  result: (value) =>
    isRecord(value) && typeof value["query"] === "string"
      ? { query: value["query"] }
      : null,
  progress: () => null,
};

const limits: PublicReadContinuationLimits = {
  leaseMs: 200,
  runBudgetMs: 5000,
  retentionMs: 60_000,
  incompleteRetentionMs: 5000,
  maxResultBytes: 1024 * 1024,
  maxAttempts: 3,
  perCallerConcurrency: 2,
  perCallerQueue: 8,
  processConcurrency: 8,
  processQueue: 16,
  followPollMs: 20,
  minRetryAfterMs: 50,
  maxRetryAfterMs: 1000,
};

const instance = (store: ContinuationStore, ownerId: string) =>
  createPublicReadContinuation<Args, Answer, null>({
    codec,
    store,
    ownerId,
    limits,
    // Deadlines here are 0 or far off; the server decides how long a lease lives.
    now: () => 0,
    sleep,
  });

if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("public-read continuation store (valkey)", () => {
    test("requires Valkey", () => undefined);
  });
} else {
  describe("public-read continuation store (valkey)", () => {
    const store = createContinuationStore({
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    });

    test("an unset key reads as absent, and a written one round-trips", async () => {
      const id = workId();
      expect(unwrapped(await store.readSpec(id))).toBeNull();
      expect(unwrapped(await store.readFinished(id))).toBeNull();
      expect(unwrapped(await store.readProgress(id))).toBeNull();

      unwrapped(await store.writeSpec(id, "spec", 60_000));
      unwrapped(await store.writeFinished(id, "finished", 60_000));
      unwrapped(await store.writeProgress(id, "progress", 60_000));

      expect(unwrapped(await store.readSpec(id))).toBe("spec");
      expect(unwrapped(await store.readFinished(id))).toBe("finished");
      expect(unwrapped(await store.readProgress(id))).toBe("progress");
    });

    test("a stored answer keeps non-ASCII text and its full size", async () => {
      const id = workId();
      const answer = "Nejvyšší soud: náhrada škody – § 2910 ".repeat(20_000);
      unwrapped(await store.writeFinished(id, answer, 60_000));
      expect(unwrapped(await store.readFinished(id))).toBe(answer);
    });

    test("every write carries the requested expiry", async () => {
      const id = workId();
      unwrapped(await store.writeFinished(id, "finished", 45_000));
      await withInspector(async ({ pttl }) => {
        const remaining = await pttl(
          coordinationKey({
            scope: "public-read-continuation",
            slot: id,
            suffix: "finished",
          }),
        );
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(45_000);
      });
    });

    test("only one owner holds a lease, and it expires", async () => {
      const id = workId();
      expect(unwrapped(await store.acquireLease(id, "a", 10_000))).toBe(true);
      expect(unwrapped(await store.acquireLease(id, "b", 10_000))).toBe(false);
      expect(unwrapped(await store.acquireLease(id, "a", 10_000))).toBe(false);
      await withInspector(async ({ get, pttl }) => {
        expect(await get(leaseKey(id))).toBe("a");
        expect(await pttl(leaseKey(id))).toBeGreaterThan(0);
      });

      const short = workId();
      expect(unwrapped(await store.acquireLease(short, "a", 20))).toBe(true);
      await waitFor(
        async () =>
          unwrapped(await store.acquireLease(short, "b", 10_000))
            ? true
            : undefined,
        { description: "the expired lease can be taken" },
      );
    });

    test("only the owner renews a lease", async () => {
      const id = workId();
      unwrapped(await store.acquireLease(id, "a", 1000));
      await withInspector(async ({ pttl }) => {
        expect(unwrapped(await store.renewLease(id, "b", 60_000))).toBe(false);
        expect(await pttl(leaseKey(id))).toBeLessThanOrEqual(1000);

        expect(unwrapped(await store.renewLease(id, "a", 60_000))).toBe(true);
        expect(await pttl(leaseKey(id))).toBeGreaterThan(1000);
      });
      expect(unwrapped(await store.renewLease(workId(), "a", 1000))).toBe(
        false,
      );
    });

    test("only the owner releases a lease", async () => {
      const id = workId();
      unwrapped(await store.acquireLease(id, "a", 60_000));
      unwrapped(await store.releaseLease(id, "b"));
      await withInspector(async ({ get }) => {
        expect(await get(leaseKey(id))).toBe("a");
        unwrapped(await store.releaseLease(id, "a"));
        expect(await get(leaseKey(id))).toBeNull();
      });
      expect(unwrapped(await store.acquireLease(id, "b", 60_000))).toBe(true);
    });

    test("attempts count up under an expiry and clear", async () => {
      const id = workId();
      expect(unwrapped(await store.countAttempt(id, 60_000))).toBe(1);
      expect(unwrapped(await store.countAttempt(id, 60_000))).toBe(2);
      await withInspector(async ({ pttl }) => {
        expect(
          await pttl(
            coordinationKey({
              scope: "public-read-continuation",
              slot: id,
              suffix: "attempts",
            }),
          ),
        ).toBeGreaterThan(0);
      });
      unwrapped(await store.clearAttempts(id));
      expect(unwrapped(await store.countAttempt(id, 60_000))).toBe(1);
    });

    test("a later attempt does not push back the counter's expiry", async () => {
      const id = workId();
      const key = coordinationKey({
        scope: "public-read-continuation",
        slot: id,
        suffix: "attempts",
      });
      unwrapped(await store.countAttempt(id, 60_000));
      await withInspector(async ({ pttl }) => {
        const first = await pttl(key);
        expect(first).toBeGreaterThan(0);
        unwrapped(await store.countAttempt(id, 600_000));
        expect(await pttl(key)).toBeLessThanOrEqual(first);
      });
    });

    test("concurrent acquires on one server admit exactly one owner", async () => {
      const id = workId();
      const results = await Promise.all(
        Array.from(
          { length: 32 },
          async (_, index) =>
            await store.acquireLease(id, `owner-${String(index)}`, 60_000),
        ),
      );
      expect(results.map(unwrapped).filter(Boolean)).toHaveLength(1);
    });
  });

  describe("public-read continuation over a real store (valkey)", () => {
    const store = createContinuationStore({
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    });

    const work = (id: string, run: (args: Args) => Promise<Answer>) => ({
      workId: id,
      caller: "caller",
      scope: "org",
      args: { query: id },
      run: async (args: Args) => Result.ok(await run(args)),
      isOverload: () => false,
      judge: () => ({ type: "complete" as const }),
    });

    test("a token issued by one task collects the answer on another", async () => {
      const id = workId();
      const gate = Promise.withResolvers<undefined>();
      const owner = instance(store, "task-a");
      const other = instance(store, "task-b");
      const running = work(id, async (args) => {
        await gate.promise;
        return args;
      });

      const first = await owner.attach({
        work: running,
        via: "call",
        responseDeadlineMs: 0,
      });
      expect(first.status).toBe("running");
      expect(await other.resolveToken(id, "org")).toEqual({
        status: "resolved",
        args: { query: id },
      });
      expect(await other.resolveToken(id, "another-org")).toEqual({
        status: "unknown",
      });

      gate.resolve(undefined);
      await owner.attach({
        work: running,
        via: "token",
        responseDeadlineMs: 5000,
      });
      expect(
        await other.attach({
          work: work(id, async () => await Promise.reject(new Error("rerun"))),
          via: "token",
          responseDeadlineMs: 5000,
        }),
      ).toEqual({ status: "finished", result: { query: id } });
    });

    test("when the owner stops renewing, another task takes the work over", async () => {
      const id = workId();
      // The dead task cannot renew; the survivor's store is untouched.
      const deadStore: ContinuationStore = {
        ...store,
        renewLease: async () => Result.ok(false),
      };
      const dead = instance(deadStore, "dead-task");
      const survivor = instance(store, "live-task");
      await dead.attach({
        work: work(
          id,
          async () => await Promise.withResolvers<Answer>().promise,
        ),
        via: "call",
        responseDeadlineMs: 0,
      });

      const recovered = await waitFor(
        async () => {
          const outcome = await survivor.attach({
            work: work(id, async (args) => await Promise.resolve(args)),
            via: "token",
            responseDeadlineMs: 0,
          });
          return outcome.status === "finished" ? outcome : undefined;
        },
        { description: "the survivor runs the work after the lease expires" },
      );
      expect(recovered).toEqual({ status: "finished", result: { query: id } });
    });
  });
}
