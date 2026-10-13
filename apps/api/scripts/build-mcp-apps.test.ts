import { expect, test } from "bun:test";

import { MCP_APPS } from "../src/mcp/apps/manifest";

test("MCP app bundles build in production without server configuration", async () => {
  const child = Bun.spawn(
    ["bun", "--no-env-file", "scripts/build-mcp-apps.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "production" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
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
