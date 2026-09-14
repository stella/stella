import { expect, test } from "bun:test";
import path from "node:path";

test("replays the recorded provider response through the real SDK without credentials", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      path.join(import.meta.dir, "ai-provider-cassette-probe.ts"),
      "replay",
      path.join(
        import.meta.dir,
        "fixtures/ai-provider-cassettes/openrouter-ok.json",
      ),
    ],
    {
      env: {
        ...process.env,
        AI_CANARY_API_KEY: "",
        OPENROUTER_API_KEY: "",
        USE_MOCK_AI: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("AI cassette replay: passed");
}, 60_000);
