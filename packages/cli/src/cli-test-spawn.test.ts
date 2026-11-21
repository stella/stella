import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REFUSING_SERVER, spawnCliSync } from "../tests/spawn-cli.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const HELPER = "tests/spawn-cli.ts";
const THIS_FILE = "src/cli-test-spawn.test.ts";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const testSources = async () => {
  const sources = new Map<string, string>();
  for await (const file of new Bun.Glob("{src,tests}/**/*.ts").scan({
    cwd: PACKAGE_DIR,
  })) {
    if (file !== HELPER && file !== THIS_FILE) {
      sources.set(file, await readFile(path.join(PACKAGE_DIR, file), "utf-8"));
    }
  }
  return sources;
};

const spawnsCli = (
  source: string,
  spawn: RegExp = /\bBun\.spawn(?:Sync)?\b/u,
) => spawn.test(source) && /\bcli\.ts\b/u.test(source);

// A synchronous spawn holds the test process: neither the test's timeout nor a
// stub server in this process acts until the child exits, so a child that
// waits on the network stalls the suite. The helper bounds the child and only
// names a server on this computer.
test("CLI tests spawn the CLI synchronously only through spawnCliSync", async () => {
  const bypasses = [...(await testSources())]
    .filter(([, source]) => spawnsCli(source, /\bBun\.spawnSync\b/u))
    .map(([file]) => file);
  expect(bypasses).toEqual([]);
});

test("CLI tests that spawn the CLI name only servers on this computer", async () => {
  const remote: string[] = [];
  for (const [file, source] of await testSources()) {
    if (!spawnsCli(source)) {
      continue;
    }
    for (const match of source.matchAll(
      /\bSTELLA_SERVER_URL:\s*["'`](?<url>https?:\/\/[^"'`]+)["'`]/gu,
    )) {
      const url = match.groups?.["url"] ?? "";
      if (!LOOPBACK_HOSTS.has(new URL(url).hostname)) {
        remote.push(`${file}: ${url}`);
      }
    }
  }
  expect(remote).toEqual([]);
});

test("spawnCliSync refuses a server that is not on this computer", () => {
  expect(() =>
    spawnCliSync(["--version"], { server: "https://stella.example" }),
  ).toThrow("must be on this computer");
});

test("a command that checks compatibility fails at once against the refusing server", () => {
  const result = spawnCliSync(["auth", "whoami"], { server: REFUSING_SERVER });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    `Could not check stella compatibility at ${REFUSING_SERVER}`,
  );
});
