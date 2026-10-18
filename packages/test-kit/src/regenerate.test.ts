import { describe, expect, test } from "bun:test";

import { createTestTmpDir } from "./tmp.ts";

const runWrite = async (path: string, flag: string) => {
  const script = `import { writeRegeneratedFile } from ${JSON.stringify(import.meta.resolve("./regenerate.ts"))}; await writeRegeneratedFile(${JSON.stringify(path)}, "contents")`;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { STELLA_UPDATE_PLAN_CONTRACTS: flag },
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr };
};

describe("writeRegeneratedFile", () => {
  test("refuses writes unless regeneration is explicit", async () => {
    const result = await runWrite("unused", "");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Set STELLA_UPDATE_PLAN_CONTRACTS=1");
  });

  test("writes when regeneration is explicit", async () => {
    const directory = await createTestTmpDir();
    const output = directory.join("baseline.json");
    expect((await runWrite(output, "1")).exitCode).toBe(0);
    expect(await Bun.file(output).text()).toBe("contents");
    await directory.remove();
  });
});
