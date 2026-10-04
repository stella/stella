import { panic } from "better-result";
import { writeFileSync } from "node:fs";

const [mode, readyPath, termMode] = process.argv.slice(2);
if (!readyPath) {
  panic("Missing readiness path");
}
if (mode === "grandchild") {
  if (termMode === "ignore") {
    process.on("SIGTERM", () => undefined);
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("ready"),
  });
  writeFileSync(
    readyPath,
    JSON.stringify({ pid: process.pid, port: server.port }),
  );
} else if (mode === "leader" || mode === "child") {
  Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      mode === "leader" ? "child" : "grandchild",
      readyPath,
      termMode ?? "exit",
    ],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.on("SIGTERM", () => {
    process.exit(0);
  });
  setInterval(() => undefined, 1000);
} else {
  panic("Unknown fixture mode");
}
