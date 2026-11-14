import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("matching locale declarations remain immutable across concurrent generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "i18n-typegen-"));
  const input = path.join(directory, "en.json");
  const output = path.join(directory, "messages.gen.ts");
  const generate = async (args: string[] = []) => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("i18n-typegen.ts", import.meta.url)),
        directory,
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  };
  try {
    await writeFile(input, JSON.stringify({ greeting: "Hello {name}" }));
    expect((await generate()).exitCode).toBe(0);
    const declaration = await readFile(output, "utf-8");
    expect(declaration).toContain('"greeting": "Hello {name}"');
    const fixedTime = new Date("2000-01-01T00:00:00Z");
    await utimes(output, fixedTime, fixedTime);
    const before = await stat(output);
    const results = await Promise.all([
      generate(),
      generate(),
      generate(["--check"]),
    ]);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0]);
    expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(output, "utf-8")).toBe(declaration);

    await writeFile(input, JSON.stringify({ greeting: "Welcome {name}" }));
    const stale = await generate(["--check"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain("out of sync with en.json");
    expect(await readFile(output, "utf-8")).toBe(declaration);
    expect((await generate()).exitCode).toBe(0);
    expect(await readFile(output, "utf-8")).toContain(
      '"greeting": "Welcome {name}"',
    );
    expect((await generate(["--check"])).exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
