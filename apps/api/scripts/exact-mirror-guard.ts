import { fileURLToPath } from "node:url";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

// Compile the server only in its owning API program. The CLI boundary preserves
// the real route guard and its self-test without importing the server type graph.
const child = Bun.spawnSync(
  [
    process.execPath,
    fileURLToPath(
      new URL("../src/scripts/exact-mirror-guard.ts", import.meta.url),
    ),
    ...process.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exit(childExitStatus(child));
