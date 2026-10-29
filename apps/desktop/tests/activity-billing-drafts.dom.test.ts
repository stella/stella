import { expect, test } from "bun:test";
import path from "node:path";

test("activity billing review keeps accepted edits through UI actions", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "test",
      "--",
      "./tests/activity-billing-drafts.dom.fixture.tsx",
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stderr, stdout, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
    child.exited,
  ]);

  const output = `${stdout}\n${stderr}`;
  expect(exitCode, output).toBe(0);
  expect(output).toMatch(/\b[1-9]\d* pass\b/u);
}, 30_000); // timeout: starts an isolated React/Tauri process and runs its consent and editing fixture suite
