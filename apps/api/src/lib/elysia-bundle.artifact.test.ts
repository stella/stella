import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("compiled Elysia validates synchronous and asynchronous Standard Schema bodies", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "stella-elysia-artifact-"));
  const entrypoint = path.join(testDir, "probe.ts");
  const executable = path.join(testDir, "probe");

  try {
    writeFileSync(
      entrypoint,
      `import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};
import * as v from ${JSON.stringify(Bun.resolveSync("valibot", import.meta.dir))};
const app = new Elysia()
  .post('/sync', ({ body }) => body, { body: v.object({ name: v.string() }) })
  .post('/async', ({ body }) => body, { body: v.objectAsync({ name: v.pipeAsync(v.string(), v.checkAsync(async (value) => value.length > 0)) }) });
const results = [];
for (const route of ['/sync', '/async']) {
  for (const body of [{ name: 'ok' }, { name: 42 }, { name: '' }]) {
    const response = await app.handle(new Request('http://localhost' + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    results.push({ route, status: response.status, body: response.ok ? await response.json() : null });
  }
}
process.stdout.write(JSON.stringify(results));
`,
    );
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--target",
        "bun",
        "--outfile",
        executable,
        entrypoint,
      ],
      env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
    const run = Bun.spawnSync({
      cmd: [executable],
      cwd: testDir,
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const output: unknown = JSON.parse(new TextDecoder().decode(run.stdout));
    expect(output).toEqual([
      { route: "/sync", status: 200, body: { name: "ok" } },
      { route: "/sync", status: 422, body: null },
      { route: "/sync", status: 200, body: { name: "" } },
      { route: "/async", status: 200, body: { name: "ok" } },
      { route: "/async", status: 422, body: null },
      { route: "/async", status: 422, body: null },
    ]);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 30_000);
