import type { ToolBinding } from "@tanstack/ai-code-mode";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { createStellaIsolateDriver } from "@/api/handlers/chat/tools/execute/sandbox/code-mode-driver";
import type { SandboxLimits } from "@/api/handlers/chat/tools/execute/sandbox/limits";

// Sandbox runs spin up isolated QuickJS contexts; match run-sandbox.test's ceiling.
setDefaultTimeout(15_000);

let driverKeyCounter = 0;
const nextKey = (): string => {
  driverKeyCounter += 1;
  return `driver-key-${driverKeyCounter}`;
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

  it("times out long host work near the deadline, not the host duration", async () => {
    const startedAt = Date.now();
    const result = await runCode({
      code: `await external_slow({}); return "ok";`,
      bindings: bindingsRecord(
        binding("external_slow", async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 800);
          });
          return { done: true };
        }),
      ),
      limits: { maxDurationMs: 100 },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("timeout");
    expect(elapsedMs).toBeLessThan(700);
  });

  it("serializes runs sharing a concurrency key through the admission queue", async () => {
    const key = nextKey();
    const started: string[] = [];
    const gate = new Map<string, () => void>();
    const bindings = bindingsRecord(
      binding("external_hold", async (args) => {
        const label = readLabel(args);
        started.push(label);
        await new Promise<void>((resolve) => {
          gate.set(label, resolve);
        });
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
    const second = runOne("second");

    await Bun.sleep(200);
    // Same key: only the first run may hold the single per-key slot.
    expect(started).toEqual(["first"]);

    gate.get("first")?.();
    await Bun.sleep(50);
    gate.get("second")?.();

    const [a, b] = await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: true });
  });
});
