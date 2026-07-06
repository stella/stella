#!/usr/bin/env bun
// Application shell for the `stella` CLI (spec 051). `stella auth *` (Phase 2)
// is real; the generated domain-command tree (Phase 3+) is still a stub
// (`stella tools list`), folding into `generatedRouteMap` from
// `./generated/route-map.js` once `generateRouteMap` (spec S5.2) ships.

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
import { generatedResourceTree } from "./generated/resource-tree.js";
import { generatedRouteMap } from "./generated/route-map.js";
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

const toolsListCommand = buildCommand({
  docs: {
    brief: "List the CLI commands generated from the stella MCP tool registry",
  },
  func(this: Context): void {
    const lines: string[] = [];
    collectLeafPaths(generatedRouteMap, [], lines);
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
    ...buildGeneratedRoutes(generatedRouteMap),
  },
});

const app = buildApplication(rootRoute, {
  name: "stella",
  // Renders (and accepts) multi-word flags as kebab-case, e.g. the
  // `keychain` flag's auto-generated negation as `--no-keychain` rather
  // than `--noKeychain` — matches the documented command surface and every
  // other kebab-case CLI convention (gh, npm, docker).
  scanner: { caseStyle: "allow-kebab-for-camel" },
  versionInfo: { currentVersion: packageJson.version },
});

// Resolved once per invocation, ahead of flag parsing (stricli's async
// `forCommand` context builder): `stella auth *` commands ignore
// `serverUrl`/`token` and resolve their own from flags (they can target a
// server other than "the current one," e.g. during first-time setup); every
// future generated command reads these directly instead of re-resolving.
const buildContext = async (): Promise<Context> => {
  const configDir = defaultConfigDir();
  const serverUrlResult = await resolveServerUrl(configDir, undefined);
  const serverUrl = Result.isOk(serverUrlResult)
    ? serverUrlResult.value
    : undefined;

  const token = serverUrl
    ? findDefaultCredential(await readCredentialFile(configDir), serverUrl)
        ?.accessToken
    : undefined;

  return { configDir, process, serverUrl, token };
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

void run(app, process.argv.slice(2), {
  forCommand: buildContext,
  process: stricliProcess,
});
