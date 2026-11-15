#!/usr/bin/env bun
// Starts the stand-in computer (`agent-local-runner.ts`) for the seeded e2e
// member on a browser stack `agent:up` did not start, such as CI's, and
// waits until the chat offers Codex on it. The local run browser suite
// (`apps/web/e2e/local-run`) then drives chats that run on it.
//
// Usage: `bun packages/scripts/src/e2e-local-runner.ts [--executable <path>]`
// against the stack at http://localhost:3001 (API) and :3000 (web). Without
// `--executable`, Cargo builds the stand-in first.

import path from "node:path";
import { parseArgs } from "node:util";

import { startLocalRunner } from "./agent-local-runner";
import { readSessionCookie } from "./agent-session";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const API_URL = "http://localhost:3001";
const WEB_URL = "http://localhost:3000";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { executable: { type: "string" } },
});

const started = await startLocalRunner({
  root: ROOT,
  apiUrl: API_URL,
  webUrl: WEB_URL,
  cookie: readSessionCookie(ROOT),
  ...(values.executable === undefined
    ? {}
    : { executable: path.resolve(values.executable) }),
});
if (started.isErr()) {
  console.error(started.error);
  process.exit(1);
}
