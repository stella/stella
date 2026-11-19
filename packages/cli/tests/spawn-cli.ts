import { panic } from "better-result";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "../src/cli.ts");

/**
 * A server origin on this computer that refuses every connection at once:
 * nothing listens on port 1. A command that reaches for its server fails
 * straight away instead of waiting on DNS or TLS for a remote host.
 */
export const REFUSING_SERVER = "http://127.0.0.1:1";

/**
 * A synchronous spawn blocks the test runner, so its own timeout cannot end
 * the test: the child is stopped once the test's time is up.
 */
const SPAWN_TIMEOUT_MS = 5000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type SpawnCliOptions = {
  /** The child's home; a fresh temporary folder by default. */
  home?: string;
  /** The child's `XDG_CACHE_HOME`; `<home>/.cache` by default. */
  cacheHome?: string;
  /** The child's `STELLA_SERVER_URL`; a server on this computer, or none. */
  server?: string;
};

/**
 * Run the CLI to completion with no stored session and none of the caller's
 * `STELLA_SERVER_URL` or `STELLA_API_KEY`. A server, when given, must be on
 * this computer: a synchronous spawn holds the test process, so a stub in
 * this process cannot answer, and a remote host makes the run wait on the
 * network. Use `REFUSING_SERVER` for a command that must fail to reach it.
 */
export const spawnCliSync = (
  args: readonly string[],
  {
    home = mkdtempSync(path.join(os.tmpdir(), "stella-cli-")),
    cacheHome = path.join(home, ".cache"),
    server,
  }: SpawnCliOptions = {},
) => {
  if (server !== undefined && !LOOPBACK_HOSTS.has(new URL(server).hostname)) {
    panic(`A CLI test server must be on this computer, not ${server}.`);
  }
  const {
    STELLA_SERVER_URL: _server,
    STELLA_API_KEY: _key,
    ...env
  } = process.env;
  return Bun.spawnSync({
    cmd: [process.execPath, CLI_ENTRYPOINT, ...args],
    env: {
      ...env,
      HOME: home,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      ...(server === undefined ? {} : { STELLA_SERVER_URL: server }),
    },
    stderr: "pipe",
    stdout: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
  });
};
