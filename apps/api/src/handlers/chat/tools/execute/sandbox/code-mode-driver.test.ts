import type { ToolBinding } from "@tanstack/ai-code-mode";
import { describe, expect, it } from "bun:test";

import { createStellaIsolateDriver } from "@/api/handlers/chat/tools/execute/sandbox/code-mode-driver";
import type { SandboxLimits } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { getSandboxAdmissionSnapshot } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";

registerSandboxTestHygiene();

let driverKeyCounter = 0;
const nextKey = (): string => {
  driverKeyCounter += 1;
  return `driver-key-${driverKeyCounter}`;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const createDeferred = (): Deferred => {
  let deferredResolve!: () => void;
  const promise = new Promise<void>((resolve) => {
    deferredResolve = resolve;
  });
  return { promise, resolve: deferredResolve };
};

// Poll a condition that is GUARANTEED to become true under correct behaviour
// (e.g. "the second run is parked in the admission queue"). The timeout is a
// generous bug guard, never an observation window tuned to expected wall-clock
// progress; a fixed "long enough" sleep is exactly what flakes on a loaded
// CI runner.
const waitForCondition = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 12_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Condition was not met before timeout.");
    }
    // oxlint-disable-next-line no-await-in-loop -- polling loop: each tick must wait before re-checking the condition
    await Bun.sleep(5);
  }
};

type BindingImpl = (args: unknown) => Promise<unknown>;

const binding = (name: string, impl: BindingImpl): ToolBinding => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute: async (args) => await impl(args),
});

const bindingsRecord = (
  ...entries: readonly ToolBinding[]
): Record<string, ToolBinding> =>
  Object.fromEntries(entries.map((b) => [b.name, b]));

const readLabel = (args: unknown): string => {
  if (args !== null && typeof args === "object" && "label" in args) {
    const { label } = args;
    return typeof label === "string" ? label : "?";
  }
  return "?";
};

type RunCodeProps = {
  code: string;
  bindings: Record<string, ToolBinding>;
  limits?: Partial<SandboxLimits>;
  concurrencyKey?: string;
};

const runCode = async ({
  code,
  bindings,
  limits,
  concurrencyKey,
}: RunCodeProps) => {
  const driver = createStellaIsolateDriver({
    concurrencyKey: concurrencyKey ?? nextKey(),
    limits,
  });
  const context = await driver.createContext({ bindings });
  try {
    return await context.execute(code);
  } finally {
    await context.dispose();
  }
};

describe("createStellaIsolateDriver", () => {
  it("round-trips an external_ binding through the read alias shim", async () => {
    const result = await runCode({
      code: `const r = await external_echo({ value: "ada" }); return r.value;`,
      bindings: bindingsRecord(binding("external_echo", async (args) => args)),
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ada");
  });

  it("exposes every binding, not just the ones a program calls", async () => {
    const result = await runCode({
      code: `return typeof external_a + ":" + typeof external_b;`,
      bindings: bindingsRecord(
        binding("external_a", async () => 1),
        binding("external_b", async () => 2),
      ),
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("function:function");
  });

  it("preserves the per-execution host-call cap", async () => {
    const result = await runCode({
      code: `for (let i = 0; i < 100; i++) { await external_ping({}); } return "done";`,
      bindings: bindingsRecord(
        binding("external_ping", async () => ({ ok: true })),
      ),
      limits: { maxHostCalls: 3 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("host-call-limit");
  });

  it("preserves the per-execution return-size cap", async () => {
    const result = await runCode({
      code: `let s = "x"; while (s.length < 5000) s += s; return s;`,
      bindings: bindingsRecord(binding("external_noop", async () => null)),
      limits: { maxReturnBytes: 1024 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("return-too-large");
  });

  it("maps a sandbox runtime failure onto NormalizedError.name", async () => {
    const result = await runCode({
      code: `throw new Error("boom");`,
      bindings: bindingsRecord(binding("external_noop", async () => null)),
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("runtime");
    expect(result.error?.message).toContain("boom");
  });

  it("maps forbidden syntax onto the forbidden-syntax reason", async () => {
    const result = await runCode({
      code: `import x from "fs"; return x;`,
      bindings: bindingsRecord(binding("external_noop", async () => null)),
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("forbidden-syntax");
  });

  it("times out at the deadline instead of waiting for unfinished host work", async () => {
    // The host call blocks on a gate the test releases only AFTER the run has
    // returned, so the run terminating with `timeout` at all proves the
    // deadline governs, not the host call's duration. No elapsed-time bound:
    // wall-clock assertions are exactly what flakes on a loaded runner.
    const hostGate = createDeferred();
    const result = await runCode({
      code: `await external_slow({}); return "ok";`,
      bindings: bindingsRecord(
        binding("external_slow", async () => {
          await hostGate.promise;
          return { done: true };
        }),
      ),
      limits: { maxDurationMs: 250 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("timeout");

    // Settle the orphaned host call so the afterEach drain stays instant.
    hostGate.resolve();
  });

  it("serializes runs sharing a concurrency key through the admission queue", async () => {
    const key = nextKey();
    const started: string[] = [];
    // Every gate exists before either run starts, so a release can never be
    // lost to timing. The previous version created each release callback only
    // when its host call began and resolved it after a fixed sleep; on a
    // loaded runner the second call had not begun yet, the release no-oped,
    // and the run hung to its 10s deadline.
    const startedGates = new Map([
      ["first", createDeferred()],
      ["second", createDeferred()],
    ]);
    const releaseGates = new Map([
      ["first", createDeferred()],
      ["second", createDeferred()],
    ]);
    const gateOf = (gates: Map<string, Deferred>, label: string): Deferred => {
      const gate = gates.get(label);
      if (!gate) {
        throw new Error(`No gate for label: ${label}`);
      }
      return gate;
    };
    const bindings = bindingsRecord(
      binding("external_hold", async (args) => {
        const label = readLabel(args);
        started.push(label);
        gateOf(startedGates, label).resolve();
        await gateOf(releaseGates, label).promise;
        return { label };
      }),
    );
    const driver = createStellaIsolateDriver({ concurrencyKey: key });

    const runOne = async (label: string): Promise<unknown> => {
      const context = await driver.createContext({ bindings });
      try {
        return await context.execute(
          `return await external_hold({ label: ${JSON.stringify(label)} });`,
        );
      } finally {
        await context.dispose();
      }
    };

    const first = runOne("first");
    await gateOf(startedGates, "first").promise;
    const second = runOne("second");

    // Once the second run is visibly parked in the admission queue, it was
    // definitively denied the single per-key slot the first still holds.
    await waitForCondition(
      () => getSandboxAdmissionSnapshot().queuedWaiters === 1,
    );
    expect(started).toEqual(["first"]);

    gateOf(releaseGates, "first").resolve();
    await gateOf(startedGates, "second").promise;
    expect(started).toEqual(["first", "second"]);
    gateOf(releaseGates, "second").resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: true });
  });
});
