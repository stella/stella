import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{
 *   loggedIn?: string;
 *   registry?: string;
 *   logout?: string;
 *   dockerBin?: string;
 * }} options
 */
export function runDockerLogout(options) {
  if (options.loggedIn !== "true" || options.logout === "false") {
    return 0;
  }
  const registry = (options.registry ?? "").trim();
  const dockerBin = options.dockerBin ?? "docker";
  const args = registry ? ["logout", registry] : ["logout"];
  const result = spawnSync(dockerBin, args, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    const target = registry || "Docker Hub";
    process.stderr.write(
      `::warning::docker logout ${target} exited with status ${result.status ?? 1}\n`,
    );
  }
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const code = runDockerLogout({
    loggedIn: process.env.STATE_logged_in,
    registry: process.env.STATE_registry,
    logout: process.env.STATE_logout,
  });
  process.exit(code);
}
