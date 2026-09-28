// Writes the rows the current code stores for the saved-state conversation
// as a new fixture in src/handlers/chat/__fixtures__/saved-state, named
// `main-<date>` unless a name is given:
//
//   bun run gen:chat-saved-state [name]
//
// Run it when `saved-state-compat.integration.test.ts` reports a stored shape
// no fixture has. See the README next to the fixtures.

import path from "node:path";

const API_ROOT = path.resolve(import.meta.dir, "..");
const TEST = "src/handlers/chat/saved-state-compat.integration.test.ts";

const name = process.argv[2] ?? `main-${new Date().toISOString().slice(0, 10)}`;
const child = Bun.spawn(
  ["bun", "run", "test", TEST, "-t", "cover the shape the current code stores"],
  {
    cwd: API_ROOT,
    env: { ...process.env, CHAT_SAVED_STATE_WRITE: name },
    stderr: "inherit",
    stdout: "inherit",
  },
);
// The run itself still fails on the old fixture set; the file is written.
await child.exited;
console.log(
  `Wrote ${path.join("src/handlers/chat/__fixtures__/saved-state", `${name}.json`)}`,
);
