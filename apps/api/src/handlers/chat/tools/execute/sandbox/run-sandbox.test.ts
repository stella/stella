import { Result } from "better-result";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as v from "valibot";

import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import type {
  RunSandboxInput,
  SandboxFunctionRegistry,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { runSandbox as runSandboxInternal } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";

// Sandbox runs spin up isolated V8 contexts; raise the bun-test ceiling so CI runner load doesn't flake. Product code enforces its own smaller deadlines.
setDefaultTimeout(15_000);

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

const waitForCondition = async ({
  condition,
  timeoutMs = 3000,
}: WaitForConditionProps): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Condition was not met before timeout.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
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

  it("times out long host work near the deadline instead of the host duration", async () => {
    const startedAt = Date.now();
    const result = await runSandbox({
      source: `await read.slow({ ms: 800 }); return "ok";`,
      registry: baseRegistry,
      limits: { maxDurationMs: 100 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("timeout");
    }
    expect(elapsedMs).toBeLessThan(700);
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
    const startedLabels: string[] = [];
    const holds = new Map<string, DeferredPromise>();
    const hold = createToolFunction(
      {
        name: "hold",
        input: v.strictObject({ label: v.string() }),
        output: v.strictObject({ label: v.string() }),
        schema: v.any(),
      },
      async function* (input) {
        startedLabels.push(input.label);
        const deferred = createDeferredPromise();
        holds.set(input.label, deferred);
        await deferred.promise;
        return Result.ok({ label: input.label });
      },
    );
    const registry: SandboxFunctionRegistry = { hold };

    const firstPromise = runSandbox({
      source: `return await read.hold({ label: "first" });`,
      registry,
      concurrencyKey: "user-a",
    });
    await waitForCondition({
      condition: () => startedLabels.length === 1,
    });

    const secondPromise = runSandbox({
      source: `return await read.hold({ label: "second" });`,
      registry,
      concurrencyKey: "user-a",
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(startedLabels).toEqual(["first"]);

    holds.get("first")?.resolve();
    await waitForCondition({
      condition: () => startedLabels.length === 2,
    });
    holds.get("second")?.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    expect(startedLabels).toEqual(["first", "second"]);
  });

  it("allows different concurrency keys to run concurrently up to the global cap", async () => {
    const startedLabels: string[] = [];
    const holds = new Map<string, DeferredPromise>();
    const hold = createToolFunction(
      {
        name: "hold",
        input: v.strictObject({ label: v.string() }),
        output: v.strictObject({ label: v.string() }),
        schema: v.any(),
      },
      async function* (input) {
        startedLabels.push(input.label);
        const deferred = createDeferredPromise();
        holds.set(input.label, deferred);
        await deferred.promise;
        return Result.ok({ label: input.label });
      },
    );
    const registry: SandboxFunctionRegistry = { hold };

    const promises = ["a", "b", "c", "d"].map(
      async (label) =>
        await runSandbox({
          source: `return await read.hold({ label: "${label}" });`,
          registry,
          concurrencyKey: `user-${label}`,
        }),
    );

    await waitForCondition({
      condition: () => startedLabels.length === 4,
    });
    expect(new Set(startedLabels)).toEqual(new Set(["a", "b", "c", "d"]));

    for (const label of startedLabels) {
      holds.get(label)?.resolve();
    }

    const results = await Promise.all(promises);
    expect(results.every(Result.isOk)).toBe(true);
  });

  it("queues a fifth distinct key until a global slot opens", async () => {
    const startedLabels: string[] = [];
    const holds = new Map<string, DeferredPromise>();
    const hold = createToolFunction(
      {
        name: "hold",
        input: v.strictObject({ label: v.string() }),
        output: v.strictObject({ label: v.string() }),
        schema: v.any(),
      },
      async function* (input) {
        startedLabels.push(input.label);
        const deferred = createDeferredPromise();
        holds.set(input.label, deferred);
        await deferred.promise;
        return Result.ok({ label: input.label });
      },
    );
    const registry: SandboxFunctionRegistry = { hold };

    const promises = ["a", "b", "c", "d", "e"].map(
      async (label) =>
        await runSandbox({
          source: `return await read.hold({ label: "${label}" });`,
          registry,
          concurrencyKey: `user-${label}`,
        }),
    );

    await waitForCondition({
      condition: () => startedLabels.length === 4,
    });
    expect(new Set(startedLabels)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(startedLabels).not.toContain("e");

    holds.get("a")?.resolve();
    await waitForCondition({
      condition: () => startedLabels.length === 5,
    });
    expect(startedLabels).toContain("e");

    for (const label of ["b", "c", "d", "e"]) {
      holds.get(label)?.resolve();
    }

    const results = await Promise.all(promises);
    expect(results.every(Result.isOk)).toBe(true);
  });

  it("does not count queue wait time against maxDurationMs", async () => {
    const holds = new Map<string, DeferredPromise>();
    const hold = createToolFunction(
      {
        name: "hold",
        input: v.strictObject({ label: v.string() }),
        output: v.strictObject({ label: v.string() }),
        schema: v.any(),
      },
      async function* (input) {
        const deferred = createDeferredPromise();
        holds.set(input.label, deferred);
        await deferred.promise;
        return Result.ok({ label: input.label });
      },
    );
    const registry: SandboxFunctionRegistry = { hold };

    const firstPromise = runSandbox({
      source: `return await read.hold({ label: "first" });`,
      registry,
      concurrencyKey: "user-a",
      limits: { maxDurationMs: 2000 },
    });
    await waitForCondition({
      condition: () => holds.has("first"),
    });

    const secondPromise = runSandbox({
      source: `return 42;`,
      registry,
      concurrencyKey: "user-a",
      limits: { maxDurationMs: 1000 },
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1200);
    });

    holds.get("first")?.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(second)) {
      expect(second.value.value).toBe(42);
    }
  });

  it("releases keyed and global slots after a timeout", async () => {
    const firstPromise = runSandbox({
      source: `await read.slow({ ms: 150 }); return "late";`,
      registry: baseRegistry,
      concurrencyKey: "user-a",
      limits: { maxDurationMs: 50 },
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    const secondPromise = runSandbox({
      source: `return 42;`,
      registry: baseRegistry,
      concurrencyKey: "user-a",
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
    const holds = new Map<string, DeferredPromise>();
    const hold = createToolFunction(
      {
        name: "hold",
        input: v.strictObject({ label: v.string() }),
        output: v.strictObject({ label: v.string() }),
        schema: v.any(),
      },
      async function* (input) {
        const deferred = createDeferredPromise();
        holds.set(input.label, deferred);
        await deferred.promise;
        return Result.ok({ label: input.label });
      },
    );
    const registry: SandboxFunctionRegistry = { hold };

    const firstPromise = runSandbox({
      source: `
        await read.hold({ label: "first" });
        throw new Error("boom");
      `,
      registry,
      concurrencyKey: "user-a",
    });
    await waitForCondition({
      condition: () => holds.has("first"),
    });

    const secondPromise = runSandbox({
      source: `return 42;`,
      registry,
      concurrencyKey: "user-a",
    });

    holds.get("first")?.resolve();

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
    const mutate = createToolFunction(
      {
        name: "mutate",
        input: v.strictObject({
          ms: v.number(),
          value: v.number(),
        }),
        output: v.strictObject({ ok: v.boolean() }),
        schema: v.any(),
      },
      async function* (input, { signal }) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, input.ms);
        });
        signal.throwIfAborted();
        sideEffect = input.value;
        return Result.ok({ ok: true });
      },
    );
    const registry: SandboxFunctionRegistry = {
      mutate,
    };

    const result = await runSandbox({
      source: `await read.mutate({ ms: 200, value: 7 }); return "done";`,
      registry,
      limits: { maxDurationMs: 50 },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("timeout");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

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
