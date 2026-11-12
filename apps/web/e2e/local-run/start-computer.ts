// Starts the stand-in computer for the seeded e2e member on a stack this
// checkout did not start with `agent:up` (the CI browser stack), and waits
// until the chat offers Codex on it. The browser tests then drive chats that
// run on it.
//
// Usage: `bun apps/web/e2e/local-run/start-computer.ts`; the stack's URLs
// come from E2E_API_URL and E2E_WEB_URL, as for the Playwright config.

import path from "node:path";

import { startLocalRunner } from "@stll/scripts/src/agent-local-runner";
import { readSessionCookie } from "@stll/scripts/src/agent-session";

import { LOCAL_RUN_ENV } from "./env";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const started = await startLocalRunner({
  root: ROOT,
  apiUrl: LOCAL_RUN_ENV.apiUrl,
  webUrl: LOCAL_RUN_ENV.webUrl,
  cookie: readSessionCookie(ROOT),
});
if (started.isErr()) {
  console.error(started.error);
  process.exit(1);
}
