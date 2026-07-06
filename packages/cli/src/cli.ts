#!/usr/bin/env bun
// Application shell for the `stella` CLI (spec 051). Startup builds the command
// tree from the baked-in `generatedRouteMap` (instant, offline); the runtime
// path (S5.3) swaps in a validated cached-listings tree only when a fetched
// `tools/list` has diverged, and refreshes the per-origin cache behind the
// fail-closed trust boundary (S5.5). `stella auth *` (Phase 2) resolves its own
// server from flags and is the one moment the cache is force-refreshed.

import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  run,
} from "@stricli/core";
import type { StricliProcess } from "@stricli/core";
import { Result } from "better-result";

import packageJson from "../package.json" with { type: "json" };
import { defaultConfigDir } from "./auth/cli-config.js";
import {
  findDefaultCredential,
  readCredentialFile,
} from "./auth/credential-store.js";
import { resolveServerUrl } from "./auth/server-resolution.js";
import { buildGeneratedRoutes, buildResourceRoutes } from "./build-cli-tree.js";
import { authRoute } from "./commands/auth.js";
import type { Context } from "./context.js";
import { HOME, XDG_CACHE_HOME } from "./env.js";
import { generatedResourceTree } from "./generated/resource-tree.js";
import {
  refreshRegistryCache,
  resolveCommandTree,
} from "./registry-refresh.js";
import type { RouteNode } from "./route-types.js";

const collectLeafPaths = (
  node: RouteNode,
  path: readonly string[],
  lines: string[],
): void => {
  if (node.kind === "leaf") {
    lines.push(`${path.join(" ")}\t(${node.spec.toolName})`);
    return;
  }
  for (const [name, child] of Object.entries(node.children)) {
    collectLeafPaths(child, [...path, name], lines);
  }
};

const buildApp = (tree: RouteNode) => {
  const toolsListCommand = buildCommand({
    docs: {
      brief:
        "List the CLI commands generated from the stella MCP tool registry",
    },
    func(this: Context): void {
      const lines: string[] = [];
      // Reflect the ACTIVE tree (the cached-listings tree when the server
      // registry has diverged), so the divergence notice's pointer is honest.
      collectLeafPaths(tree, [], lines);
      this.process.stdout.write(`${lines.sort().join("\n")}\n`);
    },
    parameters: {},
  });

  const toolsRoute = buildRouteMap({
    docs: { brief: "Inspect the generated command registry" },
    routes: { list: toolsListCommand },
  });

  const rootRoute = buildRouteMap({
    docs: { brief: "Stella command-line client" },
    routes: {
      auth: authRoute,
      tools: toolsRoute,
      reference: buildResourceRoutes(generatedResourceTree),
      ...buildGeneratedRoutes(tree),
    },
  });

  return buildApplication(rootRoute, {
    name: "stella",
    // Renders (and accepts) multi-word flags as kebab-case, e.g. the
    // `keychain` flag's auto-generated negation as `--no-keychain` rather
    // than `--noKeychain` — matches the documented command surface and every
    // other kebab-case CLI convention (gh, npm, docker).
    scanner: { caseStyle: "allow-kebab-for-camel" },
    versionInfo: { currentVersion: packageJson.version },
  });
};

const resolvePreamble = async (): Promise<{
  configDir: string;
  serverUrl: string | undefined;
  token: string | undefined;
}> => {
  const configDir = defaultConfigDir();
  const serverUrlResult = await resolveServerUrl(configDir, undefined);
  const serverUrl = Result.isOk(serverUrlResult)
    ? serverUrlResult.value
    : undefined;
  const token = serverUrl
    ? findDefaultCredential(await readCredentialFile(configDir), serverUrl)
        ?.accessToken
    : undefined;
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
  // A named slice of the env (read through `env.ts`) so the cache module never
  // touches the full `ProcessEnv` (whose index signature would not narrow to
  // `CacheEnv`).
  const cacheEnv = { XDG_CACHE_HOME, HOME };
  const { configDir, serverUrl, token } = await resolvePreamble();

  // Keep an EXISTING per-origin cache current before building the tree; a
  // missing cache stays offline-instant (seeded at `auth login` below). Any
  // transport/trust failure warns and falls back to the baked-in tree (S5.5).
  if (serverUrl !== undefined && token !== undefined && !isAuthLogin) {
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
    const refreshed = await resolvePreamble();
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

void main();
