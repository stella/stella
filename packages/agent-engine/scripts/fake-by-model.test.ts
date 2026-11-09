import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";

import type { HarnessTurn, HarnessTurnInput } from "../src/harness/adapter";
import { createClaudeCodeHarnessAdapter } from "../src/harness/claude-code/adapter";
import { createCodexHarnessAdapter } from "../src/harness/codex/adapter";
import type { HarnessEvent } from "../src/harness/events";
import {
  CLAUDE_BY_MODEL_SCENARIOS,
  scenarioForArgs,
} from "./fake-claude-code-by-model";
import { BY_MODEL_SCENARIOS } from "./fake-codex-by-model";

const CODEX_BY_MODEL = path.join(import.meta.dir, "fake-codex-by-model.ts");
const CLAUDE_BY_MODEL = path.join(
  import.meta.dir,
  "fake-claude-code-by-model.ts",
);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const folder = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-by-model-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspaceDir);
  return { home, workspaceDir, log: path.join(root, "fake.log") };
};

const codex = () => {
  const { home, workspaceDir, log } = folder();
  const adapter = createCodexHarnessAdapter({
    launch: { executable: process.execPath, args: [CODEX_BY_MODEL] },
    codexHome: home,
    environment: {
      FAKE_HARNESS_LOG: log,
      FAKE_CODEX_PACE_MS: "20",
      PATH: process.env["PATH"] ?? "",
    },
    clientVersion: "0.0.1",
    gracePeriodMs: 1000,
    requestTimeoutMs: 10_000,
    capacityRetry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 5 },
    onBackgroundError: (error) => {
      throw error;
    },
  });
  return { adapter, workspaceDir };
};

const turnInput = (workspaceDir: string, model: string): HarnessTurnInput => ({
  runId: "run-1",
  threadId: "stella-thread-1",
  workspaceDir,
  model,
  instructions: "Use the stella MCP server.",
  policy: { network: "open", fs: "workspace", approvals: "ask" },
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/mcp",
    token: "run-token",
  },
  transcript: [{ role: "user", content: "Which leases are there?" }],
  inputFiles: [],
  continuation: { type: "fresh" },
  cacheDir: path.join(tmpdir(), "stella-agent-package-cache"),
  skillFolders: [],
  toolPath: [],
});

/** Every event of a Codex turn on `model`; `onEvent` may interrupt it. */
const codexTurn = async (
  model: string,
  onEvent: (
    event: HarnessEvent,
    turn: HarnessTurn,
  ) => Promise<void> | void = () => undefined,
) => {
  const { adapter, workspaceDir } = codex();
  const started = await adapter.startTurn(turnInput(workspaceDir, model));
  if (Result.isError(started)) {
    throw started.error;
  }
  const events: HarnessEvent[] = [];
  for await (const event of started.value.events) {
    events.push(event);
    await onEvent(event, started.value);
  }
  await started.value.dispose();
  return events;
};

describe("Codex by model", () => {
  test("a probe lists one model per scenario, the first the default", async () => {
    const probed = await codex().adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value.models.map(({ id }) => id)).toEqual([
      ...BY_MODEL_SCENARIOS,
    ]);
    expect(probed.value.models.filter(({ isDefault }) => isDefault)).toEqual([
      expect.objectContaining({ id: "text" }),
    ]);
  });

  test("the text model streams an answer and completes the turn", async () => {
    const events = await codexTurn("text");
    expect(events.filter(({ type }) => type === "text.delta").length).toBe(2);
    expect(events.find(({ type }) => type === "text.completed")).toMatchObject({
      text: "Lease one is the office lease; lease two is the warehouse.",
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("the slow text model stops where it got to when interrupted", async () => {
    let deltas = 0;
    const events = await codexTurn("slow_text", async (event, turn) => {
      if (event.type === "text.delta") {
        deltas += 1;
        if (deltas === 2) {
          await turn.interrupt();
        }
      }
    });
    expect(events.at(-1)).toEqual({ type: "turn.interrupted" });
    expect(events.some(({ type }) => type === "text.completed")).toBe(false);
  });

  test("a slow scenario plays the same scenario, paced", async () => {
    const fast = await codexTurn("tool_calls");
    const slow = await codexTurn("slow_tool_calls");
    expect(slow.map(({ type }) => type)).toEqual(fast.map(({ type }) => type));
  });

  test("the usage limit model fails the turn with a reset in the future", async () => {
    const events = await codexTurn("usage_limit");
    const last = events.at(-1);
    if (last?.type !== "turn.failed" || last.failure.type !== "usage_limit") {
      throw new Error(`not a usage limit: ${JSON.stringify(last)}`);
    }
    const resetsAt = Temporal.Instant.from(last.failure.resetsAt ?? "");
    expect(Temporal.Instant.compare(resetsAt, Temporal.Now.instant())).toBe(1);
  });

  test("an unlisted model refuses to start the thread", async () => {
    const { adapter, workspaceDir } = codex();
    const started = await adapter.startTurn(turnInput(workspaceDir, "gpt-x"));
    const outcome = async () => {
      if (Result.isError(started)) {
        return "refused";
      }
      const events: HarnessEvent[] = [];
      for await (const event of started.value.events) {
        events.push(event);
      }
      await started.value.dispose();
      return events.at(-1)?.type;
    };
    // The adapter refuses the start or fails the turn; it never answers.
    expect(["refused", "turn.failed"]).toContain(await outcome());
  });
});

describe("Claude Code by model", () => {
  test("a probe lists the scenarios as the CLI's models", async () => {
    const { home, log } = folder();
    const adapter = createClaudeCodeHarnessAdapter({
      launch: { executable: process.execPath, args: [CLAUDE_BY_MODEL] },
      claudeConfigDir: home,
      environment: { FAKE_HARNESS_LOG: log, PATH: process.env["PATH"] ?? "" },
      gracePeriodMs: 1000,
      requestTimeoutMs: 10_000,
      onBackgroundError: (error) => {
        throw error;
      },
      platform: "darwin",
    });
    const probed = await adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value.models.map(({ id }) => id)).toEqual([
      ...CLAUDE_BY_MODEL_SCENARIOS,
    ]);
  });

  test("a turn plays the scenario its model names, the first for another", () => {
    const turn = ["--session-id", "s-1", "--model"];
    expect(scenarioForArgs([...turn, "approvals"])).toBe("approvals");
    expect(scenarioForArgs(["--resume", "s-1", "--model", "question"])).toBe(
      "question",
    );
    expect(scenarioForArgs([...turn, "sonnet"])).toBe("tool_calls");
    expect(scenarioForArgs(["--model", "approvals"])).toBe("probe_available");
  });
});
