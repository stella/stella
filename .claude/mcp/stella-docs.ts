import { existsSync } from "node:fs";
import { join } from "node:path";

// Auto-install deps if missing (worktrees, fresh clones).
// Check for a specific package rather than just node_modules/
// to handle partial or interrupted installs.
const sentinel = join(
  import.meta.dir,
  "node_modules",
  "@modelcontextprotocol",
);
if (!existsSync(sentinel)) {
  const proc = Bun.spawnSync(
    ["bun", "install", "--frozen-lockfile"],
    { cwd: import.meta.dir, stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    process.exit(1);
  }
}

// Spawn server as a child process so Bun doesn't eagerly
// resolve its dependency graph before install finishes.
const server = join(import.meta.dir, "server.ts");
const child = Bun.spawn(["bun", "run", server], {
  cwd: import.meta.dir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

// Forward signals so the child doesn't outlive the bootstrap
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    child.kill();
  });
}

process.exitCode = await child.exited;
