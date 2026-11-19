import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCRIPT_ERROR_MODULE = path.join(import.meta.dir, "script-error.ts");

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "script-error-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Runs `body` as a real script entry, inside `runScriptWithErrorOutput`. */
const runEntry = async (name: string, body: string) => {
  const entry = path.join(directory, `${name}.ts`);
  await writeFile(
    entry,
    `import { runScriptWithErrorOutput } from ${JSON.stringify(SCRIPT_ERROR_MODULE)};
await runScriptWithErrorOutput(async () => {
${body}
});
`,
  );
  const child = Bun.spawn([process.execPath, entry], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

describe("runScriptWithErrorOutput", () => {
  test("the entry's own exit code stands when nothing failed", async () => {
    expect((await runEntry("clean", "process.exit(0);")).code).toBe(0);
    expect((await runEntry("typed", "process.exit(7);")).code).toBe(7);
  });

  test("a rejected run exits 1 and prints the failure", async () => {
    const run = await runEntry(
      "rejected",
      `await Bun.sleep(5);
throw new Error("lock wait lost");`,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("lock wait lost");
  });

  test("a rejection nothing awaits ends the script with 1 before its entry can exit 0", async () => {
    const run = await runEntry(
      "detached",
      `void (async () => {
  await Bun.sleep(5);
  throw new Error("detached page failure");
})();
await Bun.sleep(500);
console.log("entry finished");
process.exit(0);`,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("detached page failure");
    expect(run.stdout).not.toContain("entry finished");
  });

  test("an exception thrown from a callback ends the script with 1 before its entry can exit 0", async () => {
    const run = await runEntry(
      "callback",
      `setTimeout(() => {
  throw new Error("callback failure");
}, 5);
await Bun.sleep(500);
console.log("entry finished");
process.exit(0);`,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("callback failure");
    expect(run.stdout).not.toContain("entry finished");
  });
});
