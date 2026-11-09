import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SidecarHost } from "./host";
import type { SidecarHostOutput, SidecarRunStart } from "./protocol";

/**
 * Checkpoints through the sidecar's command loop: a real host runs the fake
 * Codex app server in a real folder. The turn pauses on an approval; what the
 * test writes during the pause is what the turn changed, as far as the folder
 * can tell. Nothing reaches a model provider.
 */

const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../scripts/fake-codex-app-server.ts",
);
const PLAIN_LAUNCH = {
  configOverrides: [],
  environment: {},
  removedEnvironment: [],
  clientName: null,
  processGrant: false,
};

// timeout: each test starts the fake harness as a real process.
setDefaultTimeout(30_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

type Place = {
  root: string;
  /** A local listener standing in for the API; it refuses every upload. */
  apiOrigin: string;
  workspaceDir: string;
  fakeLog: string;
  executable: string;
};

const place = (): Place => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-host-checkpoints-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const workspaceDir = path.join(root, "agent-runs", crypto.randomUUID());
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(path.join(root, "codex-home"));
  const executable = path.join(root, "codex-approval");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" approval "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 500 }),
  });
  cleanups.push(async () => {
    await api.stop(true);
  });
  return {
    root,
    apiOrigin: `http://127.0.0.1:${String(api.port)}`,
    workspaceDir,
    fakeLog: path.join(root, "fake.log"),
    executable,
  };
};

type Host = {
  host: SidecarHost;
  /** Stops the host once; later calls wait for the same stop. */
  stop: () => Promise<void>;
  written: SidecarHostOutput[];
  /** The next message of `type`, from those written after this call. */
  upcoming: <K extends SidecarHostOutput["type"]>(
    type: K,
  ) => Promise<Extract<SidecarHostOutput, { type: K }>>;
};

const startHost = (at: Place): Host => {
  const written: SidecarHostOutput[] = [];
  const waiters = new Set<(message: SidecarHostOutput) => boolean>();
  const host = new SidecarHost({
    send: (message) => {
      written.push(message);
      for (const waiter of waiters) {
        if (waiter(message)) {
          waiters.delete(waiter);
        }
      }
      return true;
    },
    log: () => {},
    environment: {
      PATH: process.env["PATH"] ?? "",
      FAKE_HARNESS_LOG: at.fakeLog,
    },
    processGrantTimeoutMs: 10_000,
  });
  let stopped: Promise<void> | null = null;
  const stop = async () => {
    stopped ??= host.shutdown();
    await stopped;
  };
  cleanups.unshift(stop);
  host.configure("1.4.0", at.apiOrigin);
  return {
    host,
    stop,
    written,
    upcoming: async <K extends SidecarHostOutput["type"]>(type: K) => {
      const { promise, resolve } =
        Promise.withResolvers<Extract<SidecarHostOutput, { type: K }>>();
      const wanted = (
        message: SidecarHostOutput,
      ): message is Extract<SidecarHostOutput, { type: K }> =>
        message.type === type;
      waiters.add((message) => {
        if (!wanted(message)) {
          return false;
        }
        resolve(message);
        return true;
      });
      return await promise;
    },
  };
};

const runStart = (at: Place): SidecarRunStart => ({
  type: "run.start",
  runId: crypto.randomUUID(),
  threadId: "thread-1",
  harness: "codex",
  executable: at.executable,
  configDir: path.join(at.root, "codex-home"),
  launch: PLAIN_LAUNCH,
  workspaceDir: at.workspaceDir,
  cacheDir: path.join(at.root, "agent-package-cache"),
  model: "gpt-test",
  instructions: "Use the stella MCP server.",
  messages: [{ role: "user", content: "Revise the brief." }],
  attachments: [],
  skillFolders: [],
  toolPath: [],
  harnessSessionId: null,
  policy: { network: "open", fs: "workspace", approvals: "ask" },
  mcp: {
    serverName: "stella",
    url: `${at.apiOrigin}/mcp`,
    token: "run-token-1",
    expiresAt: "2026-10-28T12:00:00.000Z",
  },
});

const restoreMessage = (at: Place, runId: string) => ({
  type: "folder.restore" as const,
  requestId: crypto.randomUUID(),
  workspaceDir: at.workspaceDir,
  runId,
});

const chunksOf = (written: readonly SidecarHostOutput[], runId: string) =>
  written.flatMap((message) =>
    message.type === "run.event" && message.runId === runId
      ? [message.chunk]
      : [],
  );

const contentsOf = (dir: string, relative = ""): Record<string, string> =>
  Object.fromEntries(
    readdirSync(path.join(dir, relative), { withFileTypes: true })
      .toSorted((left, right) => (left.name < right.name ? -1 : 1))
      .flatMap((entry) => {
        const entryPath =
          relative === "" ? entry.name : `${relative}/${entry.name}`;
        return entry.isDirectory()
          ? Object.entries(contentsOf(dir, entryPath))
          : [[entryPath, readFileSync(path.join(dir, entryPath), "utf-8")]];
      }),
  );

/** Run a turn that pauses on an approval, change the folder, and finish it. */
const runTurn = async (
  at: Place,
  { host, upcoming }: Host,
  duringTurn: (runId: string) => Promise<void> | void,
) => {
  const start = runStart(at);
  const paused = upcoming("run.approval_request");
  host.handle(start);
  const { requestId } = await paused;
  await duringTurn(start.runId);
  const finished = upcoming("run.finished");
  host.handle({
    type: "run.approval",
    runId: start.runId,
    requestId,
    decision: "deny",
  });
  return { runId: start.runId, finished: await finished };
};

describe("undoing a local run's file changes", () => {
  test("a turn's changes are undone after the holder restarts; never while the run holds the folder", async () => {
    const at = place();
    writeFileSync(path.join(at.workspaceDir, "brief.txt"), "the first draft");
    mkdirSync(path.join(at.workspaceDir, "outputs"));
    writeFileSync(
      path.join(at.workspaceDir, "outputs", "earlier.txt"),
      "an earlier turn",
    );
    const before = contentsOf(at.workspaceDir);
    const first = startHost(at);
    const busy: SidecarHostOutput[] = [];
    const { runId, finished } = await runTurn(at, first, async (held) => {
      writeFileSync(
        path.join(at.workspaceDir, "brief.txt"),
        "rewritten by the agent",
      );
      writeFileSync(
        path.join(at.workspaceDir, "outputs", "report.txt"),
        "written this turn",
      );
      rmSync(path.join(at.workspaceDir, "outputs", "earlier.txt"));
      const answered = first.upcoming("folder.restored");
      first.host.handle(restoreMessage(at, held));
      busy.push(await answered);
    });
    expect(busy).toEqual([
      {
        type: "folder.restored",
        requestId: expect.any(String),
        outcome: "folder_busy",
      },
    ]);
    expect(finished.outcome).toBe("completed");
    const chunks = chunksOf(first.written, runId);
    expect(chunks.slice(0, 2)).toEqual([
      expect.objectContaining({ type: "RUN_STARTED", runId }),
      expect.objectContaining({
        type: "CUSTOM",
        name: "stella.checkpoint",
        value: { status: "taken" },
      }),
    ]);
    expect(
      chunks.filter((chunk) => chunk["name"] === "stella.checkpoint"),
    ).toHaveLength(1);
    // The turn's changes stand until the member undoes them.
    expect(contentsOf(at.workspaceDir)).not.toEqual(before);
    await first.stop();

    // A new holder reads the checkpoint the first one wrote.
    const second = startHost(at);
    const restore = restoreMessage(at, runId);
    const answered = second.upcoming("folder.restored");
    second.host.handle(restore);
    expect(await answered).toEqual({
      type: "folder.restored",
      requestId: restore.requestId,
      outcome: "restored",
    });
    expect(contentsOf(at.workspaceDir)).toEqual(before);
    // Undone once.
    const again = second.upcoming("folder.restored");
    second.host.handle(restoreMessage(at, runId));
    expect((await again).outcome).toBe("not_newest");
  });

  test("a folder past a bound runs its turn without an undo", async () => {
    const at = place();
    const deep = path.join(
      at.workspaceDir,
      ...Array.from({ length: 10 }, (_, index) => `level-${String(index)}`),
    );
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "dependency.js"), "module.exports = 1;");
    const turn = startHost(at);
    const { runId, finished } = await runTurn(at, turn, () => {});
    expect(finished.outcome).toBe("completed");
    expect(chunksOf(turn.written, runId)).toContainEqual(
      expect.objectContaining({
        type: "CUSTOM",
        name: "stella.checkpoint",
        value: { status: "unavailable", reason: "too_large" },
      }),
    );
    const answered = turn.upcoming("folder.restored");
    turn.host.handle(restoreMessage(at, runId));
    expect((await answered).outcome).toBe("no_checkpoint");
  });

  test("a run that starts while its folder is restored fails without starting its harness", async () => {
    const at = place();
    const { host, upcoming } = startHost(at);
    const restored = upcoming("folder.restored");
    const finished = upcoming("run.finished");
    host.handle(restoreMessage(at, crypto.randomUUID()));
    host.handle(runStart(at));
    expect((await finished).outcome).toBe("failed");
    expect((await restored).outcome).toBe("no_checkpoint");
    expect(existsSync(at.fakeLog)).toBe(false);
  });
});
