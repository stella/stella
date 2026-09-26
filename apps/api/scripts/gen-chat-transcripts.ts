// Records the chat conversations the web app replays through its rendered
// chat (apps/web/src/components/chat/__fixtures__/recorded-conversations):
// each scenario in src/handlers/chat/recorded-conversations.integration.test.ts
// runs through the real send pipeline and the web chat runtime, and its
// requests, SSE bodies and message pages are written as JSON.
//
//   bun run gen:chat-transcripts          record every scenario again
//   bun run gen:chat-transcripts --check  fail when a committed recording
//                                         differs from a fresh one
//
// The check is the same test the api suite runs, so CI fails on a stale
// recording without running this script. A recording in which the page never
// posted a message is refused and the committed file kept, and a recording
// whose scenario no longer exists is removed.

import path from "node:path";

const API_ROOT = path.resolve(import.meta.dir, "..");
const RECORDER = "src/handlers/chat/recorded-conversations.integration.test.ts";

const check = process.argv.includes("--check");
const child = Bun.spawn(["bun", "run", "test", RECORDER], {
  cwd: API_ROOT,
  env: { ...process.env, ...(check ? {} : { CHAT_TRANSCRIPTS_WRITE: "1" }) },
  stderr: "inherit",
  stdout: "inherit",
});
process.exit(await child.exited);
