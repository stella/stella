import { expect, test } from "bun:test";

import { MCP_APPS } from "../src/mcp/apps/manifest";

test("MCP app bundles build in production without server configuration", async () => {
  const apiRoot = new URL("..", import.meta.url).pathname;
  const outputs = [
    ...new Bun.Glob("src/mcp/apps/*/generated/*").scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
  ].toSorted();
  const readOutputs = async () =>
    await Promise.all(
      outputs.map(async (file) => Bun.file(`${apiRoot}/${file}`).text()),
    );
  const before = await readOutputs();
  const child = Bun.spawn(
    ["bun", "--no-env-file", "scripts/build-mcp-apps.ts", "--check"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain(
    `Checked ${MCP_APPS.length} MCP app bundles without writing outputs`,
  );
  expect(await readOutputs()).toEqual(before);
  for (const app of MCP_APPS) {
    expect(
      await Bun.file(
        new URL(
          `../src/mcp/apps/${app.directory}/generated/app.html.txt`,
          import.meta.url,
        ),
      ).exists(),
    ).toBe(true);
  }
}, 30_000);
