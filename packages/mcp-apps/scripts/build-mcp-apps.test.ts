import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import { MCP_APPS } from "../src/manifest";

test("MCP app bundles build in production without server configuration or output writes", async () => {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const readOutputs = async () =>
    await Promise.all(
      [
        ...new Bun.Glob("src/**/generated/**/*").scanSync({
          cwd: packageRoot,
          onlyFiles: true,
        }),
      ]
        .toSorted()
        .map(async (file) => {
          const filename = path.join(packageRoot, file);
          return {
            file,
            hash: sha256Hex(await Bun.file(filename).bytes()),
            modified: (await stat(filename)).mtimeMs,
          };
        }),
    );
  const before = await readOutputs();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "scripts/build-mcp-apps.ts", "--check"],
    {
      cwd: packageRoot,
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
}, 30_000);
