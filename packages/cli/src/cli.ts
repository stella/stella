#!/usr/bin/env bun
// Application shell for the `stella` CLI (spec 051, Phase 1 scaffold only).
//
// No generator, no auth, no real domain commands yet: `stella tools list` is a
// stub that proves the stricli route-map wires up end to end. Real commands
// arrive once `generateRouteMap` (spec S5.2) and the Annotation Table (spec
// S1) ship in a later phase, folding into `generatedRouteMap` from
// `./generated/route-map.js`.

import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  run,
} from "@stricli/core";

import packageJson from "../package.json" with { type: "json" };
import type { Context } from "./context.js";

const toolsListCommand = buildCommand({
  docs: {
    brief: "List the CLI commands generated from the stella MCP tool registry",
  },
  func(this: Context): void {
    this.process.stdout.write("stella tools list: not yet implemented\n");
  },
  parameters: {},
});

const toolsRoute = buildRouteMap({
  docs: { brief: "Inspect the generated command registry" },
  routes: { list: toolsListCommand },
});

const rootRoute = buildRouteMap({
  docs: { brief: "Stella command-line client" },
  routes: { tools: toolsRoute },
});

const app = buildApplication(rootRoute, {
  name: "stella",
  versionInfo: { currentVersion: packageJson.version },
});

// Server resolution and stored auth are out of scope for this phase (spec
// 051 covers both in later phases); the context carries their final shape
// with placeholder values until then.
const buildContext = (): Context => ({
  process,
  serverUrl: "",
  token: undefined,
});

void run(app, process.argv.slice(2), buildContext());
