#!/usr/bin/env bun
// Application shell for the `stella` CLI (spec 051). Startup builds the command
// tree from the baked-in `generatedRouteMap` (instant, offline); the runtime
// path (S5.3) swaps in a validated cached-listings tree only when a fetched
// `tools/list` has diverged, and refreshes the per-origin cache behind the
// fail-closed trust boundary (S5.5). `stella auth *` (Phase 2) resolves its own
// server from flags and is the one moment the cache is force-refreshed.

import { run } from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { Result } from "better-result";

import { defaultConfigDir } from "./auth/config-dir.js";
import { resolveAccessToken } from "./auth/resolve-access-token.js";
import { resolveServerUrl } from "./auth/server-resolution.js";
import { buildApp } from "./build-cli-tree.js";
import { commandNeedsRegistry } from "./command-locality.js";
import { HOME, XDG_CACHE_HOME } from "./env.js";
import { reportFatalError } from "./main-error-boundary.js";
import { preparseServerFlag } from "./preparse-server-flag.js";
import {
  refreshRegistryCache,
  resolveCommandTree,
} from "./registry-refresh.js";

const resolvePreamble = async (
  serverFlag: string | undefined,
): Promise<{
  configDir: string;
  serverUrl: string | undefined;
  token: string | undefined;
}> => {
  const configDir = defaultConfigDir();
  const serverUrlResult = await resolveServerUrl({
    configDir,
    flagValue: serverFlag,
  });
  const serverUrl = Result.isOk(serverUrlResult)
    ? serverUrlResult.value
    : undefined;
  if (serverUrl === undefined) {
    return { configDir, serverUrl: undefined, token: undefined };
  }

  // The single choke point where a stored credential becomes a request token:
  // an expired/near-expiry access token is refreshed (and the rotation
  // persisted) before use, so a valid refresh token keeps commands working
  // without a re-login. A refresh failure (or no credential) yields no token,
  // so the command path's established "Not signed in" / exit-`auth` contract
  // still applies, and the startup registry refresh below is skipped rather
  // than firing a doomed request that 401-warns on a stale token.
  const resolved = await resolveAccessToken({ configDir, serverUrl });
  if (resolved.status === "refresh-failed") {
    // Surface the specific reason (e.g. "no refresh token, run `stella auth
    // login` again") instead of letting the command path's generic "Not
    // signed in" message stand in for it.
    process.stderr.write(`${resolved.error.message}\n`);
  }
  if (resolved.status === "ok" && resolved.persistWarning !== undefined) {
    // The refresh succeeded but couldn't be saved to disk (read-only config
    // dir, full disk); the token below is still valid for this command.
    process.stderr.write(`${resolved.persistWarning}\n`);
  }
  const token = resolved.status === "ok" ? resolved.token : undefined;
  return { configDir, serverUrl, token };
};

// SAFETY: Node's `process.exitCode` type allows an explicit `undefined`
// value (not just "absent"), which conflicts with stricli's own
// `StricliProcess.exitCode?: string | number | null` under this package's
// `exactOptionalPropertyTypes`. The real process object satisfies
// `StricliProcess` at runtime regardless (it has every field stricli reads
// or writes); this is a type-only mismatch between two independently-typed
// libraries, not an actual runtime risk. Passing the real `process` (rather
// than a constructed stand-in) matters: stricli sets `context.process.exitCode`
// on it directly, and that must land on the process that is actually exiting.
// eslint-disable-next-line no-unsafe-type-assertion -- see SAFETY comment above
const stricliProcess = process as unknown as StricliProcess & typeof process;

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const isAuthLogin = argv.at(0) === "auth" && argv.at(1) === "login";
  // Purely local commands (`--help`, `auth whoami`, `tools list`, ...) read no
  // server registry, so they must not pay the `tools/list` round-trip; only a
  // command that consumes the command tree triggers the pre-dispatch refresh.
  const needsRegistry = commandNeedsRegistry(argv);
  // A named slice of the env (read through `env.ts`) so the cache module never
  // touches the full `ProcessEnv` (whose index signature would not narrow to
  // `CacheEnv`).
  const cacheEnv = { XDG_CACHE_HOME, HOME };
  // `--server` is parsed by every command, but it has to be read here too: the
  // origin (and the credential bound to it) is resolved before stricli
  // dispatches, so an argv scan is what makes the flag work on every command
  // rather than only on the ones that resolve a server themselves.
  const serverFlag = preparseServerFlag(argv);
  const { configDir, serverUrl, token } = await resolvePreamble(serverFlag);

  // Keep an EXISTING per-origin cache current before building the tree; a
  // missing cache stays offline-instant (seeded at `auth login` below). Any
  // transport/trust failure warns and falls back to the baked-in tree (S5.5).
  if (serverUrl !== undefined && token !== undefined && needsRegistry) {
    const outcome = await refreshRegistryCache({
      serverOrigin: serverUrl,
      token,
      env: cacheEnv,
    });
    if (outcome.status === "failed") {
      process.stderr.write(`${outcome.warning}\n`);
    } else if (outcome.status === "refreshed" && outcome.nudge !== undefined) {
      process.stderr.write(`${outcome.nudge}\n`);
    }
  }

  // Startup always resolves against the baked-in tree unless a validated cache
  // shows a non-empty delta, in which case build from the cached listings and
  // surface the one-line divergence notice (spec S5.3). No network here.
  const { tree, notice } = await resolveCommandTree({
    serverOrigin: serverUrl,
    env: cacheEnv,
  });
  if (notice !== undefined) {
    process.stderr.write(notice);
  }

  await run(buildApp(tree), argv, {
    forCommand: () => ({ configDir, process, serverUrl, token }),
    process: stricliProcess,
  });

  // Seed/refresh the cache right after a successful `auth login` (the one
  // explicit-network moment), using the freshly stored credential.
  if (isAuthLogin) {
    const refreshed = await resolvePreamble(serverFlag);
    if (refreshed.serverUrl !== undefined && refreshed.token !== undefined) {
      const outcome = await refreshRegistryCache({
        serverOrigin: refreshed.serverUrl,
        token: refreshed.token,
        env: cacheEnv,
        force: true,
      });
      if (outcome.status === "failed") {
        process.stderr.write(`${outcome.warning}\n`);
      } else if (
        outcome.status === "refreshed" &&
        outcome.nudge !== undefined
      ) {
        process.stderr.write(`${outcome.nudge}\n`);
      }
    }
  }
};

// Top-level boundary: map anything that escapes startup I/O to the CLI's
// exit-code contract instead of letting it surface as an unhandled rejection.
main().catch((error: unknown) => reportFatalError(error, process));
