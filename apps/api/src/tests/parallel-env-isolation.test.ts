import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

const VARIABLE = "STELLA_PARALLEL_ENV_ISOLATION_PROBE";

// The API runner (scripts/run-tests.ts) relies on `bun test --parallel`
// isolating each file, including `process.env`: several suites set a variable
// at module scope. One worker runs both files in path order, so `a` sets the
// variable before `b` reads it.
test("bun test --parallel keeps a module-scope environment change out of the next file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "parallel-env-isolation-"));
  try {
    writeFileSync(
      path.join(directory, "a.test.ts"),
      `import { test } from "bun:test";\nprocess.env["${VARIABLE}"] = "leaked";\ntest("sets", () => {});\n`,
    );
    writeFileSync(
      path.join(directory, "b.test.ts"),
      `import { expect, test } from "bun:test";\ntest("reads", () => { expect(process.env["${VARIABLE}"]).toBeUndefined(); });\n`,
    );
    const child = Bun.spawn(
      [process.execPath, "test", "--parallel=1", "./a.test.ts", "./b.test.ts"],
      {
        cwd: directory,
        env: { ...process.env, [VARIABLE]: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await child.exited;
    expect(childExitStatus(child)).toBe(0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
