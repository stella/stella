import { existsSync } from "node:fs";
import path from "node:path";

// Auto-install deps if missing (worktrees, fresh clones).
// Check for a specific package rather than just node_modules/
// to handle partial or interrupted installs.
const sentinel = path.join(
  import.meta.dir,
  "node_modules",
  "@modelcontextprotocol",
);
if (!existsSync(sentinel)) {
  const proc = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: import.meta.dir,
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    process.exit(1);
  }
}

// Run the server in this same process. A dynamic import defers
// dependency resolution until runtime (after the install above); a
// static top-level import would resolve it at parse time, before the
// deps exist. This avoids a second "babysitter" process per session.
await import("./server.ts");
