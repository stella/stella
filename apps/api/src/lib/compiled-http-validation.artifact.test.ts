import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The API ships as one `bun build --compile` binary, so request validation is
// checked in a compiled probe too: a bundler that dropped or reordered the
// Standard Schema path would pass every in-process test and still let bodies
// through in production.

const API_ROOT = path.join(import.meta.dir, "..", "..");
const httpModule = (name: string) =>
  JSON.stringify(path.join(API_ROOT, "src", "http", `${name}.ts`));

test("the compiled HTTP core validates synchronous and asynchronous Standard Schema bodies", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "stella-http-artifact-"));
  const entrypoint = path.join(testDir, "probe.ts");
  const executable = path.join(testDir, "probe");

  try {
    writeFileSync(
      entrypoint,
      `import { createHttpApp } from ${httpModule("app")};
import { isHttpFailure } from ${httpModule("errors")};
import { decodeRequestInput } from ${httpModule("input")};
import { toResponse } from ${httpModule("respond")};
import { routes } from ${httpModule("route")};
import { status } from ${httpModule("status")};
import { serveForTest } from ${JSON.stringify(path.join(API_ROOT, "src", "tests", "helpers", "test-server.ts"))};
import * as v from ${JSON.stringify(Bun.resolveSync("valibot", import.meta.dir))};
const echo = (schema) => ({
  access: 'public',
  config: { body: schema },
  run: async ({ readBody }) => await decodeRequestInput(schema, await readBody()),
});
const refusals = async (ctx, inner) => {
  try {
    return await inner();
  } catch (error) {
    if (!isHttpFailure(error)) throw error;
    return toResponse(status(error.kind === 'invalid_request' ? 422 : 400, error.kind), ctx.set);
  }
};
const server = serveForTest(createHttpApp({
  middleware: [refusals],
  routes: routes({
    '/sync': { POST: echo(v.object({ name: v.string() })) },
    '/async': { POST: echo(v.objectAsync({ name: v.pipeAsync(v.string(), v.checkAsync(async (value) => value.length > 0)) })) },
  }),
}));
const results = [];
for (const route of ['/sync', '/async']) {
  for (const body of [{ name: 'ok' }, { name: 42 }, { name: '' }]) {
    const response = await server.fetch('http://localhost' + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    results.push({ route, status: response.status, body: response.ok ? await response.json() : null });
  }
}
await server.stop();
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
        "--tsconfig-override",
        path.join(API_ROOT, "tsconfig.json"),
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
}, 30_000); // timeout: compiling the core into one executable takes seconds.
