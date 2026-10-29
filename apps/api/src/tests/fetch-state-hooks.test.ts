import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { asFetchMock } from "./helpers/test-tool-set";

test("fetch mocks provide inert preconnect without borrowing ambient fetch", async () => {
  const mock = asFetchMock(async () => new Response("fixture"));
  mock.preconnect("https://example.invalid");
  expect(await (await mock("https://example.invalid")).text()).toBe("fixture");
});

test("registered provider replays restore fetch between tests while retaining the cached function", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-replay-cleanup-"));
  const preload = path.join(import.meta.dirname, "fetch-state-hooks.ts");
  const replayOwner = path.join(
    import.meta.dirname,
    "helpers/provider-wire-replay.ts",
  );
  try {
    const replayFile = path.join(directory, "replay.test.ts");
    writeFileSync(
      replayFile,
      `import { afterAll, beforeAll, test, expect } from "bun:test";
import { registerProviderWireReplay } from ${JSON.stringify(replayOwner)};
const originalFetch = globalThis.fetch;
let setupFinished = false;
let cachedFetch;
registerProviderWireReplay({
  onInstall: () => {},
  options: () => {
    expect(setupFinished).toBe(true);
    return {};
  },
});
beforeAll(() => { setupFinished = true; });
test("first replay is scoped", () => {
  expect(globalThis.fetch).not.toBe(originalFetch);
  cachedFetch = globalThis.fetch;
});
test("next replay keeps the SDK cached function", () => {
  expect(globalThis.fetch).toBe(cachedFetch);
});
afterAll(() => { expect(globalThis.fetch).toBe(originalFetch); });`,
    );
    const run = () =>
      Bun.spawnSync({
        cmd: [process.execPath, "test", "--preload", preload, replayFile],
        cwd: directory,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
    const guarded = run();
    const output = guarded.stderr.toString();
    expect(guarded.exitCode, output).toBe(0);
    expect(output).toContain("2 pass");
    expect(output).toContain("0 fail");

    writeFileSync(
      replayFile,
      `import { test } from "bun:test";
import { registerProviderWireReplay } from ${JSON.stringify(replayOwner)};
registerProviderWireReplay({ onInstall: () => {} });
test("unowned fetch replacement", () => {
  globalThis.fetch = async () => new Response("leaked");
});`,
    );
    const leaked = run();
    expect(leaked.exitCode).not.toBe(0);
    expect(leaked.stderr.toString()).toContain("Test leaked globalThis.fetch");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fetch cleanup fails the leaking test and restores fetch before later tests and files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-fetch-cleanup-"));
  const preload = path.join(import.meta.dirname, "fetch-state-hooks.ts");
  try {
    const leakingFile = path.join(directory, "leaking.test.ts");
    const cleanFile = path.join(directory, "clean.test.ts");
    writeFileSync(
      leakingFile,
      `import { test, expect } from "bun:test";
const originalFetch = globalThis.fetch;
test("leaking fetch fixture", () => {
  globalThis.fetch = async () => new Response("leaked");
});
test("same file sees restored fetch", () => {
  expect(globalThis.fetch).toBe(originalFetch);
  expect(typeof globalThis.fetch.preconnect).toBe("function");
});`,
    );
    writeFileSync(
      cleanFile,
      `import { afterEach, describe, test, expect } from "bun:test";
const originalFetch = globalThis.fetch;
describe("local cleanup", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });
  test("another file starts clean", () => {
    expect(typeof globalThis.fetch.preconnect).toBe("function");
    globalThis.fetch = async () => new Response("scoped");
  });
});`,
    );
    const run = (preloads: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, "test", ...preloads, leakingFile, cleanFile],
        cwd: directory,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

    // The unguarded fixture must actually contaminate its successor: this is
    // also the mutation check for removing the preload from the runner.
    const unguarded = run([]);
    expect(unguarded.exitCode).not.toBe(0);
    expect(unguarded.stderr.toString()).toContain(
      "(fail) same file sees restored fetch",
    );

    const guarded = run(["--preload", preload]);
    const output = guarded.stderr.toString();
    expect(guarded.exitCode).not.toBe(0);
    expect(output).toContain("Test leaked globalThis.fetch");
    expect(output).toContain("(fail) leaking fetch fixture");
    expect(output).toContain("(pass) same file sees restored fetch");
    expect(output).toContain(
      "(pass) local cleanup > another file starts clean",
    );
    expect(output).toContain("1 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
