// Application shell for the `stella` CLI (spec 051), loaded by the `cli.ts`
// entry point once its dependencies resolve. Startup builds the command
// tree from the baked-in `generatedRouteMap` (instant, offline); the runtime
// path (S5.3) swaps in a validated cached-listings tree only when a fetched
// `tools/list` has diverged, and refreshes the per-origin cache behind the
// fail-closed trust boundary (S5.5). `stella auth *` (Phase 2) resolves its own
// server from flags and is the one moment the cache is force-refreshed.

import { run } from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { Result } from "better-result";

import {
  actionAdmissionRefusalOutput,
  type CliActionAdmissionRefusal,
} from "./action-admission-refusal.js";
import { defaultConfigDir } from "./auth/config-dir.js";
import { resolveAccessToken } from "./auth/resolve-access-token.js";
import { resolveServerUrl } from "./auth/server-resolution.js";
import { buildApp } from "./build-cli-tree.js";
import { normalizeProcessExitCode } from "./cli-exit-code.js";
import { commandNeedsRegistry } from "./command-locality.js";
import { HOME, XDG_CACHE_HOME } from "./env.js";
import type { CallerFeatureAccess } from "./feature-command-projection.js";
import { generatedRouteMap } from "./generated/route-map.js";
import { reportFatalError } from "./main-error-boundary.js";
import { EXIT_CODES, resolveMcpErrorCodeExit } from "./mcp-constants.js";
import { preparseServerFlag } from "./preparse-server-flag.js";
import {
  formatRegistryDrift,
  preparseVerboseFlag,
  removedCommandError,
  shouldReportRegistryDrift,
} from "./registry-drift.js";
import type { CurrentRegistry } from "./registry-refresh.js";
import {
  refreshRegistryCache,
  resolveCommandTree,
  requiresFeatureAccessRefresh,
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
// oxlint-disable-next-line no-unsafe-type-assertion -- see SAFETY comment above
const stricliProcess = process as unknown as StricliProcess & typeof process;

const refuseAdmission = (
  refusal: CliActionAdmissionRefusal,
  argv: readonly string[],
): void => {
  const outputIndex = argv.indexOf("--output");
  const format =
    argv.includes("--json") ||
    argv.includes("--output=json") ||
    argv.includes("--output=jsonl") ||
    (outputIndex !== -1 &&
      (argv.at(outputIndex + 1) === "json" ||
        argv.at(outputIndex + 1) === "jsonl"))
      ? "json"
      : "table";
  process.stderr.write(actionAdmissionRefusalOutput({ refusal, format }));
  process.exitCode = resolveMcpErrorCodeExit(refusal.code) ?? EXIT_CODES.server;
};

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
  const requiresFeatureSnapshot = requiresFeatureAccessRefresh();
  let currentRegistry: CurrentRegistry | undefined;
  let featureAccess: CallerFeatureAccess | undefined;
  if (
    serverUrl !== undefined &&
    token !== undefined &&
    (needsRegistry || requiresFeatureSnapshot)
  ) {
    const outcome = await refreshRegistryCache({
      serverOrigin: serverUrl,
      token,
      env: cacheEnv,
      force: requiresFeatureSnapshot,
    });
    if (outcome.status === "refreshed") {
      featureAccess = outcome.featureAccess;
      currentRegistry = outcome.registry;
    }
    if (outcome.status === "admission-refused") {
      refuseAdmission(outcome.refusal, argv);
      return;
    }
    if (outcome.status === "failed") {
      process.stderr.write(`${outcome.warning}\n`);
    } else if (outcome.status === "refreshed" && outcome.nudge !== undefined) {
      process.stderr.write(`${outcome.nudge}\n`);
    }
  }

  // Only this invocation's validated response can project caller commands.
  // Disk supplies deployment metadata; resolution itself performs no network.
  const { tree, drift, disabled } = await resolveCommandTree({
    serverOrigin: serverUrl,
    env: cacheEnv,
    ...(currentRegistry === undefined ? {} : { registry: currentRegistry }),
    ...(featureAccess === undefined ? {} : { featureAccess }),
  });
  if (drift !== undefined) {
    // The one place the drift is reported, so "once per process" is structural
    // rather than a latch. Always stderr: a `--json` caller pipes stdout into a
    // parser, and a warning mixed in there is a parse error.
    if (shouldReportRegistryDrift(argv)) {
      process.stderr.write(
        formatRegistryDrift({
          delta: drift,
          verbose: preparseVerboseFlag(argv),
        }),
      );
    }
    // Quieting the background noise must not quiet the one case that stops this
    // command: its tool is gone from the server. Reported whatever the command,
    // `--help` included, because there is nothing left to help with.
    const removed = removedCommandError({
      argv,
      baked: generatedRouteMap,
      delta: drift,
    });
    if (removed !== undefined) {
      process.stderr.write(removed);
      // The same class the server's own `unknown_tool` envelope maps to.
      process.exitCode = EXIT_CODES.server;
      return;
    }
  }

  await run(buildApp(tree, disabled), argv, {
    forCommand: () => ({ configDir, process, serverUrl, token }),
    process: stricliProcess,
  });
  // stricli reports its own parse failures (unknown command, bad flag) with
  // negative codes the OS folds into 251/252; the contract calls them usage
  // errors (exit 2).
  process.exitCode = normalizeProcessExitCode(process.exitCode);

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
      if (outcome.status === "admission-refused") {
        refuseAdmission(outcome.refusal, argv);
        return;
      }
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
