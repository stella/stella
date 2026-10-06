import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CHAT_ORACLE } from "../src/tests/helpers/chat-oracles";

test("data-only checking requires exactly one mutation target without executing scenarios", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mutation-targets-"));
  try {
    const target = path.join(directory, "target.ts");
    const matrix = path.join(directory, "matrix.json");
    writeFileSync(
      matrix,
      JSON.stringify({
        entries: [
          {
            id: "fixture-target",
            behaviour: "fixture behaviour",
            fix: "fixture",
            status: "active",
            file: path.relative(
              path.resolve(import.meta.dirname, ".."),
              target,
            ),
            search: "target text",
            replace: "mutated text",
            scenario: { file: "must-not-execute.test.ts", test: "never runs" },
            oracle: CHAT_ORACLE.persistedTurnOutcome,
          },
        ],
      }),
    );
    for (const { source, occurrences, exitCode } of [
      { source: "target text", occurrences: 1, exitCode: 0 },
      { source: "target moved", occurrences: 0, exitCode: 1 },
      { source: "target text target text", occurrences: 2, exitCode: 1 },
    ]) {
      writeFileSync(target, source);
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dirname, "chat-mutation-matrix.ts"),
          "--check",
          "--matrix",
          matrix,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(exitCode);
      if (occurrences === 1) {
        expect(stdout).toContain("1 entries valid");
        expect(stderr).toBe("");
      } else {
        expect(stderr).toContain(
          `fixture-target: the mutation no longer applies (${occurrences} matches`,
        );
      }
      expect(stdout + stderr).not.toContain("must-not-execute");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
