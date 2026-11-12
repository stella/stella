#!/usr/bin/env bun
// Starts the stand-in computer (`agent-local-runner.ts`) for the seeded e2e
// member on a browser stack `agent:up` did not start, such as CI's, and
// waits until the chat offers Codex on it. The local run browser suite
// (`apps/web/e2e/local-run`) then drives chats that run on it.
//
// Usage: `bun packages/scripts/src/e2e-local-runner.ts [api url] [web url]`;
// the stack's defaults are http://localhost:3001 and http://localhost:3000.

import path from "node:path";

import { startLocalRunner } from "./agent-local-runner";
import { readSessionCookie } from "./agent-session";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const [apiUrl = "http://localhost:3001", webUrl = "http://localhost:3000"] =
  process.argv.slice(2);

const started = await startLocalRunner({
  root: ROOT,
  apiUrl,
  webUrl,
  cookie: readSessionCookie(ROOT),
});
if (started.isErr()) {
  console.error(started.error);
  process.exit(1);
}
