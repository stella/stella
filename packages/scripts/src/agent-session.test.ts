import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { devStatePath, writeDevRuntime } from "./dev-runtime";

const PAUSE_LIFTED_MESSAGE =
  "The sealed stack scheduler pause is lifted or a job is still running; run `bun run agent:reset` before agent:drive";

test("agent command help explains scheduler resume and resealing without starting a stack", () => {
  const help = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dir, "agent-session.ts"),
      "drive",
      "--help",
    ],
    { cwd: tmpdir() },
  );
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("bun run agent:scheduler-resume");
  expect(help.stdout.toString()).toContain("bun run agent:reset");
});

test.each(["paused", "lifted"] as const)(
  "drive starts the browser only when the sealed scheduler remains paused (%s)",
  async (schedulerState) => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-agent-drive-test-"));
    const health = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("healthy"),
    });
    const runnerPath = path.join(root, "packages/scripts/src/dev-runner.ts");
    const browserMarker = path.join(root, "browser-started");
    const pauseCheckMarker = path.join(root, "scheduler-checked");
    mkdirSync(path.dirname(runnerPath), { recursive: true });
    mkdirSync(path.join(root, "apps/api/scripts"), { recursive: true });
    mkdirSync(path.join(root, "apps/web/e2e/agent"), { recursive: true });
    writeFileSync(runnerPath, "setInterval(() => {}, 60_000);\n");
    const runner = Bun.spawn({
      cmd: [process.execPath, runnerPath],
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      const apiUrl = `http://127.0.0.1:${String(health.port)}`;
      writeDevRuntime(root, {
        apiUrl,
        dockerProject: null,
        infraOffset: 0,
        mode: "dev",
        pid: runner.pid,
        seeded: true,
        startedAt: "2020-01-01T00:00:00.000Z",
        webUrl: apiUrl,
      });
      writeFileSync(
        devStatePath(root, "agent-key.json"),
        JSON.stringify({ apiUrl, id: "fixture-key", key: "local-test-key" }),
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(root, "apps/api/scripts/seed-seal.ts"),
        'console.log(JSON.stringify({ status: "pristine" }));\n',
      );
      writeFileSync(
        path.join(root, "apps/api/scripts/agent-scheduler.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(pauseCheckMarker)}, "checked");`,
          ...(schedulerState === "lifted"
            ? [
                `console.error(${JSON.stringify(PAUSE_LIFTED_MESSAGE)});`,
                "process.exit(1);",
              ]
            : []),
        ].join("\n"),
      );
      writeFileSync(
        path.join(root, "apps/web/e2e/agent/drive.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(browserMarker)}, "started");`,
        ].join("\n"),
      );
      const entryPath = path.join(root, "drive-test.ts");
      writeFileSync(
        entryPath,
        [
          `import { drive } from ${JSON.stringify(path.join(import.meta.dir, "agent-session.ts"))};`,
          `await drive(${JSON.stringify(root)}, []);`,
        ].join("\n"),
      );
      const driveProcess = Bun.spawn({
        cmd: [process.execPath, entryPath],
        cwd: root,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        driveProcess.exited,
        new Response(driveProcess.stderr).text(),
      ]);

      expect(existsSync(pauseCheckMarker)).toBe(true);
      expect(existsSync(browserMarker)).toBe(schedulerState === "paused");
      expect(exitCode).toBe(schedulerState === "paused" ? 0 : 1);
      if (schedulerState === "lifted") {
        expect(stderr).toContain(PAUSE_LIFTED_MESSAGE);
      }
    } finally {
      runner.kill();
      await runner.exited;
      await health.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
