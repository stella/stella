import { Result } from "better-result";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import type {
  RunSandboxInput,
  SandboxFunctionRegistry,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import {
  SandboxAdmissionNotIdleError,
  awaitSandboxAdmissionIdle,
  getSandboxAdmissionSnapshot,
  runSandbox as runSandboxInternal,
  trackSandboxHostWorkForTest,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";

registerSandboxTestHygiene();

type RunTestSandboxProps = Omit<RunSandboxInput, "concurrencyKey"> & {
  concurrencyKey?: string;
};

let sandboxConcurrencyKeyCounter = 0;

const nextSandboxConcurrencyKey = (): string => {
  sandboxConcurrencyKeyCounter += 1;
  return `test-user-${sandboxConcurrencyKeyCounter}`;
};

const runSandbox = async ({ concurrencyKey, ...props }: RunTestSandboxProps) =>
  await runSandboxInternal({
    ...props,
    concurrencyKey: concurrencyKey ?? nextSandboxConcurrencyKey(),
  });

type DeferredPromise = {
  promise: Promise<void>;
  reject: (reason?: unknown) => void;
  resolve: () => void;
};

const createDeferredPromise = (): DeferredPromise => {
  let deferredResolve!: DeferredPromise["resolve"];
  let deferredReject!: DeferredPromise["reject"];
  const promise = new Promise<void>((resolve, reject) => {
    deferredResolve = () => {
      resolve();
    };
    deferredReject = reject;
  });

  return {
    promise,
    reject: deferredReject,
    resolve: deferredResolve,
  };
};

type WaitForConditionProps = {
  condition: () => boolean;
  timeoutMs?: number;
};

// Poll a condition that is GUARANTEED to become true under correct behaviour
// (e.g. "the second run has been pushed onto the admission queue"). The
// timeout is a bug guard, not an observation window: it only fires when the
// property under test is actually broken, so it is set generously (just below
// the 15s per-test ceiling) rather than tuned to expected wall-clock progress.
// Never use this to wait a fixed interval "long enough" for background work.
const waitForCondition = async ({
  condition,
  timeoutMs = 12_000,
}: WaitForConditionProps): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Condition was not met before timeout.");
    }
    // oxlint-disable-next-line no-await-in-loop -- polling loop: each tick must wait before re-checking the condition
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

// Observe "exactly N runs are parked in the admission queue" as a state
// transition on the live counters. Once a waiter is visibly queued, admission
// has already run and denied it a slot, so asserting "it has not started" right
// after this is deterministic — no sleep window that a slow runner can miss.
const waitForQueuedWaiters = async (count: number): Promise<void> => {
  await waitForCondition({
    condition: () => getSandboxAdmissionSnapshot().queuedWaiters === count,
  });
};

type HoldGate = {
  registry: SandboxFunctionRegistry;
  startedLabels: string[];
  whenStarted: (label: string) => Promise<void>;
  release: (label: string) => void;
};

/**
 * A gated `read.hold({ label })` tool whose lifecycle the test controls through
 * explicit promises instead of wall-clock waits: `whenStarted(label)` resolves
 * once the host call for that label has begun (its run was admitted and reached
 * the host bridge) and `release(label)` lets it return. Every gate is created
 * upfront, so a release can never be lost to timing: even if it fires before
 * the host call starts, the call finds its gate already resolved. That ordering
 * hole (releasing a gate that did not exist yet, so the run hung to its
 * deadline) is exactly what sank the previous sleep-based versions on a loaded
 * CI runner.
 */
const createHoldGate = (labels: readonly string[]): HoldGate => {
  const startedGates = new Map(
    labels.map((label) => [label, createDeferredPromise()]),
  );
  const releaseGates = new Map(
    labels.map((label) => [label, createDeferredPromise()]),
  );
  const startedLabels: string[] = [];

  const gateFor = (
    gates: Map<string, DeferredPromise>,
    label: string,
  ): DeferredPromise => {
    const gate = gates.get(label);
    if (!gate) {
      throw new Error(`No hold gate was created for label: ${label}`);
    }
    return gate;
  };

  const hold = createToolFunction(
    {
      name: "hold",
      input: v.strictObject({ label: v.string() }),
      output: v.strictObject({ label: v.string() }),
      schema: v.any(),
    },
    async function* (input) {
      startedLabels.push(input.label);
      gateFor(startedGates, input.label).resolve();
      await gateFor(releaseGates, input.label).promise;
      return Result.ok({ label: input.label });
    },
  );

  return {
    registry: { hold },
    startedLabels,
    whenStarted: async (label) => await gateFor(startedGates, label).promise,
    release: (label) => {
      gateFor(releaseGates, label).resolve();
    },
  };
};

const echo = createToolFunction(
  {
    name: "echo",
    input: v.strictObject({ value: v.string() }),
    output: v.strictObject({ value: v.string() }),
    schema: v.any(),
  },
  async function* (input) {
    return Result.ok({ value: input.value });
  },
);

const add = createToolFunction(
  {
    name: "add",
    input: v.strictObject({
      a: v.number(),
      b: v.number(),
    }),
    output: v.strictObject({ sum: v.number() }),
    schema: v.any(),
  },
  async function* (input) {
    return Result.ok({ sum: input.a + input.b });
  },
);

const slow = createToolFunction(
  {
    name: "slow",
    input: v.strictObject({ ms: v.number() }),
    output: v.strictObject({ done: v.boolean() }),
    schema: v.any(),
  },
  async function* (input) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, input.ms);
    });
    return Result.ok({ done: true });
  },
);

const noop = createToolFunction(
  {
    name: "noop",
    input: v.strictObject({}),
    output: v.undefined(),
    schema: v.any(),
  },
  async function* () {
    return Result.ok(undefined);
  },
);

const baseRegistry: SandboxFunctionRegistry = {
  echo,
  add,
  noop,
  slow,
};

describe("runSandbox", () => {
  it("returns the value the program returned", async () => {
    const result = await runSandbox({
      source: `return 1 + 2;`,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe(3);
    }
  });

  it("round-trips a host call through the bridge", async () => {
    const result = await runSandbox({
      source: `
        const r = await read.echo({ value: "ada" });
        return r.value;
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("ada");
      expect(result.value.hostCalls).toBe(1);
    }
  });

  it("supports multiple sequential awaits", async () => {
    const result = await runSandbox({
      source: `
        const a = await read.add({ a: 1, b: 2 });
        const b = await read.add({ a: a.sum, b: 3 });
        return b.sum;
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe(6);
      expect(result.value.hostCalls).toBe(2);
    }
  });

  it("waits for a slow host call after several fast ones in a loop (pending host work must drop completed calls)", async () => {
    const result = await runSandbox({
      source: `
        for (let i = 0; i < 3; i++) {
          await read.echo({ value: String(i) });
        }
        return await read.slow({ ms: 40 });
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toEqual({ done: true });
      expect(result.value.hostCalls).toBe(4);
    }
  });

  it("resolves when the program returns a read promise without await (async return chaining)", async () => {
    const result = await runSandbox({
      source: `return read.slow({ ms: 40 });`,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toEqual({ done: true });
      expect(result.value.hostCalls).toBe(1);
    }
  });

  it("lets try/catch handle a rejecting read call when using return await", async () => {
    const result = await runSandbox({
      source: `
        try {
          return await read.echo({ value: 123 });
        } catch (err) {
          return "caught";
        }
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("caught");
      expect(result.value.hostCalls).toBe(1);
    }
  });

  it("does not run try/catch when returning a rejecting read promise without await", async () => {
    const result = await runSandbox({
      source: `
        try {
          return read.echo({ value: 123 });
        } catch (err) {
          return "caught";
        }
      `,
      registry: baseRegistry,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("runtime");
    }
  });

  it("trips the host-call cap", async () => {
    const result = await runSandbox({
      source: `
        for (let i = 0; i < 100; i++) {
          await read.echo({ value: "x" });
        }
        return "done";
      `,
      registry: baseRegistry,
      limits: { maxHostCalls: 3 },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("host-call-limit");
    }
  });

  it("aborts an infinite loop on wall-clock timeout", async () => {
    const result = await runSandbox({
      source: `while (true) {}`,
      registry: baseRegistry,
      limits: { maxDurationMs: 200 },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("timeout");
    }
  });

  it("times out at the deadline instead of waiting for unfinished host work", async () => {
    // The host call blocks on a gate the test releases only AFTER the run has
    // returned, so the run terminating with `timeout` at all proves the
    // deadline governs, not the host call's duration. No elapsed-time bound:
    // wall-clock assertions are exactly what flakes on a loaded runner.
    const gate = createHoldGate(["slow-host"]);
    const result = await runSandbox({
      source: `await read.hold({ label: "slow-host" }); return "ok";`,
      registry: gate.registry,
      limits: { maxDurationMs: 250 },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("timeout");
    }

    // Settle the orphaned host call so the afterEach drain stays instant.
    gate.release("slow-host");
  });

  it("aborts an exponential allocation on memory limit", async () => {
    const result = await runSandbox({
      source: `
        let s = "a";
        for (let i = 0; i < 40; i++) s += s;
        return s.length;
      `,
      registry: baseRegistry,
      limits: { maxMemoryBytes: 1024 * 1024 },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(["memory", "runtime"]).toContain(result.error.reason);
    }
  });

  it("rejects deep recursion when the stack limit is small", async () => {
    const result = await runSandbox({
      source: `
        function f(n) {
          if (n <= 0) return 0;
          return 1 + f(n - 1);
        }
        return f(200000);
      `,
      registry: baseRegistry,
      limits: {
        maxStackBytes: 32 * 1024,
        maxDurationMs: 1000,
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("runtime");
      expect(result.error.message.toLowerCase()).toContain("stack");
    }
  });

  it("keeps later runs working after a memory limit failure", async () => {
    const first = await runSandbox({
      source: `return "x".repeat(8 * 1024 * 1024);`,
      registry: baseRegistry,
      limits: { maxMemoryBytes: 1024 * 1024 },
    });
    const second = await runSandbox({
      source: `return 42;`,
      registry: baseRegistry,
    });

    expect(Result.isError(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first)) {
      expect(first.error.reason).toBe("memory");
    }
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(42);
      expect(second.value.hostCalls).toBe(0);
    }
  });

  it("hides fetch, process, require, and import on globalThis", async () => {
    // Bun's transpiler constant-folds bare \`typeof require\` to "function";
    // probe \`globalThis.require\` instead, which reflects the real runtime.
    const result = await runSandbox({
      source: `
        return {
          fetch: typeof globalThis.fetch,
          process: typeof globalThis.process,
          require: typeof globalThis.require,
          xhr: typeof globalThis.XMLHttpRequest,
        };
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toEqual({
        fetch: "undefined",
        process: "undefined",
        require: "undefined",
        xhr: "undefined",
      });
    }
  });

  it("rejects source containing a require() call before transpile", async () => {
    const result = await runSandbox({
      source: `const fs = require("fs"); return fs;`,
      registry: baseRegistry,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("rejects calls to unknown registry functions", async () => {
    const result = await runSandbox({
      source: `
        try {
          await read.doesNotExist({});
          return "no-throw";
        } catch (err) {
          return "threw: " + (err && err.message ? err.message : String(err));
        }
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(String(result.value.value)).toContain("threw:");
      expect(String(result.value.value)).toContain("doesNotExist");
    }
  });

  it("surfaces validation errors as catchable rejections in the sandbox", async () => {
    const result = await runSandbox({
      source: `
        try {
          // value should be string, but we pass a number
          await read.echo({ value: 123 });
          return "no-throw";
        } catch (err) {
          return "caught";
        }
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("caught");
    }
  });

  it("treats console.log as a no-op", async () => {
    const result = await runSandbox({
      source: `
        console.log("hi");
        console.warn("warn");
        console.error("err");
        console.info("info");
        console.debug("debug");
        return "ok";
      `,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("ok");
    }
  });

  it("rejects a return value larger than maxReturnBytes", async () => {
    const result = await runSandbox({
      source: `
        let s = "x";
        while (s.length < 5000) s += s;
        return s;
      `,
      registry: baseRegistry,
      limits: { maxReturnBytes: 1024 },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("return-too-large");
    }
  });

  it("counts multibyte return values in UTF-8 bytes", async () => {
    const result = await runSandbox({
      source: `return "ą".repeat(700);`,
      registry: baseRegistry,
      limits: { maxReturnBytes: 1024 },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("return-too-large");
    }
  });

  it("round-trips undefined from host functions", async () => {
    const result = await runSandbox({
      source: `return await read.noop({});`,
      registry: baseRegistry,
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBeUndefined();
      expect(result.value.hostCalls).toBe(1);
    }
  });

  it("does not treat read as a thenable during promise resolution", async () => {
    const result = await runSandbox({
      source: `
        await Promise.resolve(read);
        return "resolved";
      `,
      registry: baseRegistry,
      limits: { maxDurationMs: 1000 },
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("resolved");
      expect(result.value.hostCalls).toBe(0);
    }
  });

  it("counts host calls per execution and does not share state across runs", async () => {
    const first = await runSandbox({
      source: `await read.echo({ value: "a" }); return "ok";`,
      registry: baseRegistry,
    });
    const second = await runSandbox({
      source: `return "ok";`,
      registry: baseRegistry,
    });
    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(first)) {
      expect(first.value.hostCalls).toBe(1);
    }
    if (Result.isOk(second)) {
      expect(second.value.hostCalls).toBe(0);
    }
  });

  it("executes repeated runs in separate global contexts", async () => {
    const source = `
      globalThis.counter = (globalThis.counter ?? 0) + 1;
      return globalThis.counter;
    `;
    const first = await runSandbox({
      source,
      registry: baseRegistry,
    });
    const second = await runSandbox({
      source,
      registry: baseRegistry,
    });

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(first)) {
      expect(first.value.value).toBe(1);
    }
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(1);
    }
  });

  it("isolates parallel runs even when they mutate the same global name", async () => {
    const [left, right] = await Promise.all([
      runSandbox({
        source: `
          globalThis.token = "left";
          await read.slow({ ms: 50 });
          return globalThis.token;
        `,
        registry: baseRegistry,
      }),
      runSandbox({
        source: `
          globalThis.token = "right";
          await read.slow({ ms: 50 });
          return globalThis.token;
        `,
        registry: baseRegistry,
      }),
    ]);

    expect(Result.isOk(left)).toBe(true);
    expect(Result.isOk(right)).toBe(true);
    if (Result.isOk(left)) {
      expect(left.value.value).toBe("left");
      expect(left.value.hostCalls).toBe(1);
    }
    if (Result.isOk(right)) {
      expect(right.value.value).toBe("right");
      expect(right.value.hostCalls).toBe(1);
    }
  });

  it("serializes runs for the same concurrency key", async () => {
    const concurrencyKey = nextSandboxConcurrencyKey();
    const gate = createHoldGate(["first", "second"]);

    const firstPromise = runSandbox({
      source: `return await read.hold({ label: "first" });`,
      registry: gate.registry,
      concurrencyKey,
    });
    await gate.whenStarted("first");

    const secondPromise = runSandbox({
      source: `return await read.hold({ label: "second" });`,
      registry: gate.registry,
      concurrencyKey,
    });

    // Once the second run is visibly parked in the admission queue, it was
    // definitively denied a slot while the first still holds the per-key slot.
    await waitForQueuedWaiters(1);
    expect(gate.startedLabels).toEqual(["first"]);

    gate.release("first");
    await gate.whenStarted("second");
    expect(gate.startedLabels).toEqual(["first", "second"]);
    gate.release("second");

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
  });

  it("allows different concurrency keys to run concurrently up to the global cap", async () => {
    const concurrencyKeyPrefix = nextSandboxConcurrencyKey();
    const labels = ["a", "b", "c", "d"];
    const gate = createHoldGate(labels);

    const promises = labels.map(
      async (label) =>
        await runSandbox({
          source: `return await read.hold({ label: "${label}" });`,
          registry: gate.registry,
          concurrencyKey: `${concurrencyKeyPrefix}-${label}`,
        }),
    );

    // All four host calls start while every release gate is still closed, so
    // the four runs are provably in flight at the same time.
    await Promise.all(labels.map(async (label) => gate.whenStarted(label)));
    expect(new Set(gate.startedLabels)).toEqual(new Set(labels));

    for (const label of labels) {
      gate.release(label);
    }

    const results = await Promise.all(promises);
    expect(results.every(Result.isOk)).toBe(true);
  });

  it("queues a fifth distinct key until a global slot opens", async () => {
    const concurrencyKeyPrefix = nextSandboxConcurrencyKey();
    const labels = ["a", "b", "c", "d", "e"];
    const gate = createHoldGate(labels);

    // Admission waiters are pushed synchronously in call order, so with the
    // global cap at 4 exactly a-d are admitted and e is queued.
    const promises = labels.map(
      async (label) =>
        await runSandbox({
          source: `return await read.hold({ label: "${label}" });`,
          registry: gate.registry,
          concurrencyKey: `${concurrencyKeyPrefix}-${label}`,
        }),
    );

    const admitted = ["a", "b", "c", "d"];
    await Promise.all(admitted.map(async (label) => gate.whenStarted(label)));
    // e being visibly parked in the queue proves it was denied a slot while
    // all four admitted runs are still holding theirs.
    await waitForQueuedWaiters(1);
    expect(new Set(gate.startedLabels)).toEqual(new Set(admitted));
    expect(gate.startedLabels).not.toContain("e");

    gate.release("a");
    await gate.whenStarted("e");
    expect(gate.startedLabels).toContain("e");

    for (const label of ["b", "c", "d", "e"]) {
      gate.release(label);
    }

    const results = await Promise.all(promises);
    expect(results.every(Result.isOk)).toBe(true);
  });

  it("does not count queue wait time against maxDurationMs", async () => {
    const concurrencyKey = nextSandboxConcurrencyKey();
    const gate = createHoldGate(["first"]);

    // The first run's deadline must comfortably outlast the queued interval
    // below plus any load-induced slack; only the second run's budget is under
    // test.
    const firstPromise = runSandbox({
      source: `return await read.hold({ label: "first" });`,
      registry: gate.registry,
      concurrencyKey,
      limits: { maxDurationMs: 12_000 },
    });
    await gate.whenStarted("first");

    const secondBudgetMs = 2000;
    const secondPromise = runSandbox({
      source: `return 42;`,
      registry: gate.registry,
      concurrencyKey,
      limits: { maxDurationMs: secondBudgetMs },
    });
    await waitForQueuedWaiters(1);

    // Keep the second run queued for strictly longer than its entire execution
    // budget. The property is inherently about wall-clock, but the wait only
    // needs a MINIMUM (Bun.sleep guarantees at-least semantics), so runner
    // load can only lengthen the queued interval — it exercises the property
    // harder, it can never fake a pass or force a failure.
    await Bun.sleep(secondBudgetMs + 250);
    gate.release("first");

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(42);
    }
  });

  it("releases keyed and global slots after a timeout", async () => {
    const concurrencyKey = nextSandboxConcurrencyKey();
    // Admission waiters are pushed synchronously in call order: the first run
    // takes the per-key slot and the second queues behind it, no spacing sleep
    // needed. The second run can only succeed if the first's timeout released
    // both the keyed and the global slot.
    const firstPromise = runSandbox({
      source: `await read.slow({ ms: 150 }); return "late";`,
      registry: baseRegistry,
      concurrencyKey,
      limits: { maxDurationMs: 50 },
    });
    const secondPromise = runSandbox({
      source: `return 42;`,
      registry: baseRegistry,
      concurrencyKey,
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isError(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first)) {
      expect(first.error.reason).toBe("timeout");
    }
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(42);
    }
  });

  it("releases keyed and global slots after a runtime failure", async () => {
    const concurrencyKey = nextSandboxConcurrencyKey();
    const gate = createHoldGate(["first"]);

    const firstPromise = runSandbox({
      source: `
        await read.hold({ label: "first" });
        throw new Error("boom");
      `,
      registry: gate.registry,
      concurrencyKey,
    });
    await gate.whenStarted("first");

    const secondPromise = runSandbox({
      source: `return 42;`,
      registry: gate.registry,
      concurrencyKey,
    });

    gate.release("first");

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isError(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first)) {
      expect(first.error.reason).toBe("runtime");
    }
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(42);
    }
  });

  it("does not leak prototype pollution between runs", async () => {
    const polluted = await runSandbox({
      source: `
        Array.prototype.pwned = "yes";
        return [].pwned;
      `,
      registry: baseRegistry,
    });
    const clean = await runSandbox({
      source: `return [].pwned === undefined ? "clean" : [].pwned;`,
      registry: baseRegistry,
    });

    expect(Result.isOk(polluted)).toBe(true);
    expect(Result.isOk(clean)).toBe(true);
    if (Result.isOk(polluted)) {
      expect(polluted.value.value).toBe("yes");
    }
    if (Result.isOk(clean)) {
      expect(clean.value.value).toBe("clean");
    }
  });

  it("keeps healthy parallel runs working while another run times out", async () => {
    const [timedOut, healthy] = await Promise.all([
      runSandbox({
        source: `await read.slow({ ms: 300 }); return "late";`,
        registry: baseRegistry,
        limits: { maxDurationMs: 50 },
      }),
      runSandbox({
        source: `const r = await read.echo({ value: "healthy" }); return r.value;`,
        registry: baseRegistry,
      }),
    ]);

    expect(Result.isError(timedOut)).toBe(true);
    expect(Result.isOk(healthy)).toBe(true);
    if (Result.isError(timedOut)) {
      expect(timedOut.error.reason).toBe("timeout");
    }
    if (Result.isOk(healthy)) {
      expect(healthy.value.value).toBe("healthy");
      expect(healthy.value.hostCalls).toBe(1);
    }
  });

  it("keeps later runs clean after a timed out host call finishes in the background", async () => {
    const timedOut = await runSandbox({
      source: `await read.slow({ ms: 300 }); return "late";`,
      registry: baseRegistry,
      limits: { maxDurationMs: 50 },
    });
    const clean = await runSandbox({
      source: `return typeof globalThis.afterTimeoutLeak === "undefined" ? "clean" : globalThis.afterTimeoutLeak;`,
      registry: baseRegistry,
    });

    expect(Result.isError(timedOut)).toBe(true);
    expect(Result.isOk(clean)).toBe(true);
    if (Result.isError(timedOut)) {
      expect(timedOut.error.reason).toBe("timeout");
    }
    if (Result.isOk(clean)) {
      expect(clean.value.value).toBe("clean");
    }
  });

  it("cannot recover deleted host globals through function constructors", async () => {
    const result = await runSandbox({
      source: `
        const escape = read.echo.constructor(
          "return [typeof globalThis.process, typeof globalThis.require, typeof globalThis.fetch].join(':')",
        );
        return escape();
      `,
      registry: baseRegistry,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("undefined:undefined:undefined");
    }
  });

  it("does not expose the raw bridge function on globalThis", async () => {
    const result = await runSandbox({
      source: `return typeof globalThis.__readCall;`,
      registry: baseRegistry,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("undefined");
    }
  });

  it("only allows explicitly registered own functions", async () => {
    const hidden = createToolFunction(
      {
        name: "hidden",
        input: v.strictObject({}),
        output: v.strictObject({ leaked: v.boolean() }),
        schema: v.any(),
      },
      async function* () {
        return Result.ok({ leaked: true });
      },
    );
    const registry: SandboxFunctionRegistry = {};
    Object.setPrototypeOf(registry, { hidden });

    const result = await runSandbox({
      source: `
        try {
          await read.hidden({});
          return "leaked";
        } catch (error) {
          return String(error && error.message ? error.message : error);
        }
      `,
      registry,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).not.toBe("leaked");
      expect(String(result.value.value)).toContain("Unknown read function");
    }
  });

  it("passes an abort signal to host handlers so they can avoid committing after timeout", async () => {
    let sideEffect = 0;
    // The host call blocks on a gate the test releases only AFTER the run has
    // returned (i.e. after the bridge's AbortController has fired), so the
    // signal check runs at a deterministic point instead of racing two timers.
    const commitGate = createDeferredPromise();
    const mutate = createToolFunction(
      {
        name: "mutate",
        input: v.strictObject({ value: v.number() }),
        output: v.strictObject({ ok: v.boolean() }),
        schema: v.any(),
      },
      async function* (input, { signal }) {
        await commitGate.promise;
        signal.throwIfAborted();
        sideEffect = input.value;
        return Result.ok({ ok: true });
      },
    );
    const registry: SandboxFunctionRegistry = {
      mutate,
    };

    const result = await runSandbox({
      source: `await read.mutate({ value: 7 }); return "done";`,
      registry,
      limits: { maxDurationMs: 250 },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("timeout");
    }

    // Let the (now aborted) host call proceed to its commit check, then await
    // its full unwind through the drain — an event, not a fixed sleep.
    commitGate.resolve();
    await awaitSandboxAdmissionIdle();

    expect(sideEffect).toBe(0);
  });

  it("rejects ESM import syntax before execution", async () => {
    const result = await runSandbox({
      source: `import x from "fs";`,
      registry: baseRegistry,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("rejects ESM export syntax before execution", async () => {
    const result = await runSandbox({
      source: `export const x = 1;`,
      registry: baseRegistry,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });
});

describe("awaitSandboxAdmissionIdle", () => {
  // A host call that never settles (and ignores the abort signal) strands its
  // in-flight promise in the process-global set once its run returns at the
  // deadline. The drain must not then hang for the full per-test timeout on
  // this test and every later one: it fails fast with the live counters and
  // evicts the strand so the next drain is clean. This is the class guard for
  // the "every sandbox test uniformly times out at ~15s" flake.
  //
  // The strand is injected directly rather than constructed through a real
  // run: with a real run, a small maxDurationMs races QuickJS startup on a
  // loaded runner and the host call may never begin, which made the previous
  // version of this test flake in CI. The injected shape (an entry in the
  // in-flight set with no admitted run) is byte-for-byte what such a run
  // leaves behind. The drain budget is an injected parameter here, and the
  // assertions are about the thrown diagnostic and its counters — never about
  // wall-clock progress.
  it("fails fast with a diagnostic when a host promise is stranded, then unpoisons", async () => {
    trackSandboxHostWorkForTest(
      new Promise<void>(() => {
        // never settles; models a stranded host call
      }),
    );

    let thrown: unknown;
    try {
      await awaitSandboxAdmissionIdle({ timeoutMs: 250 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxAdmissionNotIdleError);
    if (thrown instanceof SandboxAdmissionNotIdleError) {
      // No run is admitted or queued; only the host tail is stranded.
      expect(thrown.snapshot).toEqual({
        activeSandboxCount: 0,
        queuedWaiters: 0,
        hostWorkInFlight: 1,
      });
    }

    // The strand was evicted, so a subsequent drain resolves instead of
    // cascading the poison into the next test or file.
    await awaitSandboxAdmissionIdle({ timeoutMs: 250 });
  });
});
