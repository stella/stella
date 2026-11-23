import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NON_RETRYABLE_AUTH_ERROR =
  /incorrect username or password|invalid username or password|bad credentials/iu;

/** @param {string} output */
export function isNonRetryableLoginError(output) {
  return NON_RETRYABLE_AUTH_ERROR.test(output);
}

/** @param {string} value */
function escapeCommandData(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/** @param {string} secret */
function maskSecret(secret) {
  for (const line of secret.split(/\r?\n/u)) {
    if (line.length > 0) {
      process.stdout.write(`::add-mask::${line}\n`);
    }
  }
}

/** @param {string} raw */
function parsePositiveInt(raw, fallback) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    throw new Error(`Expected positive integer, got "${raw}"`);
  }
  return Number(trimmed);
}

/** @param {string} raw */
function parseDelays(raw, fallback) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parts = trimmed.split(/\s+/u);
  for (const part of parts) {
    if (!/^[0-9]+$/u.test(part)) {
      throw new Error(`Expected non-negative integer delay, got "${part}"`);
    }
  }
  return parts.map(Number);
}

/** @param {number} seconds */
async function defaultSleep(seconds) {
  if (seconds <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * @param {string | undefined} statePath
 * @param {Record<string, string>} entries
 */
function saveState(statePath, entries) {
  if (!statePath) {
    return;
  }
  const lines = Object.entries(entries).map(([key, value]) => {
    const clean = value.replaceAll("\r", "").replaceAll("\n", "");
    return `${key}=${clean}\n`;
  });
  appendFileSync(statePath, lines.join(""), "utf-8");
}

/**
 * @param {{
 *   registry?: string;
 *   username: string;
 *   password: string;
 *   logout?: string;
 *   attempts?: number;
 *   delaysSeconds?: number[];
 *   statePath?: string;
 *   dockerBin?: string;
 *   sleep?: (seconds: number) => Promise<void>;
 * }} options
 */
export async function runDockerLogin(options) {
  const registry = (options.registry ?? "").trim();
  const username = options.username.trim();
  const password = options.password;
  const logout = (options.logout ?? "true").trim() || "true";
  const attempts = options.attempts ?? 3;
  const delays = options.delaysSeconds ?? [5, 15];
  const dockerBin = options.dockerBin ?? "docker";
  const sleep = options.sleep ?? defaultSleep;
  const target = registry || "Docker Hub";

  if (!username) {
    process.stderr.write("::error::docker-login: username is required\n");
    return 1;
  }
  if (!password) {
    process.stderr.write("::error::docker-login: password is required\n");
    return 1;
  }

  maskSecret(password);

  const args = ["login", "--username", username, "--password-stdin"];
  if (registry) {
    args.push(registry);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(dockerBin, args, {
      input: `${password}\n`,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    if (result.error) {
      const message = result.error.message;
      process.stderr.write(`docker-login: spawn failed: ${message}\n`);
    }

    const status = result.status ?? 1;
    if (status === 0 && !result.error) {
      if (attempt > 1) {
        process.stderr.write(
          `::warning::docker login ${escapeCommandData(target)} succeeded on attempt ${attempt}/${attempts}\n`,
        );
      }
      saveState(options.statePath, {
        logged_in: "true",
        registry,
        logout,
      });
      return 0;
    }

    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (isNonRetryableLoginError(combined)) {
      process.stderr.write(
        `::error::docker login ${escapeCommandData(target)} failed with non-retryable credentials error (exit ${status})\n`,
      );
      return status || 1;
    }

    if (attempt === attempts) {
      process.stderr.write(
        `::error::docker login ${escapeCommandData(target)} failed after ${attempts} attempts (exit ${status})\n`,
      );
      return status || 1;
    }

    const delayIndex = Math.min(attempt - 1, delays.length - 1);
    const delay = delays[delayIndex] ?? 5;
    process.stderr.write(
      `docker-login: attempt ${attempt}/${attempts} failed for ${target} (exit ${status}); retrying in ${delay}s\n`,
    );
    await sleep(delay);
  }

  return 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const code = await runDockerLogin({
    registry: process.env.INPUT_REGISTRY ?? "",
    username: process.env.INPUT_USERNAME ?? "",
    password: process.env.INPUT_PASSWORD ?? "",
    logout: process.env.INPUT_LOGOUT ?? "true",
    attempts: parsePositiveInt(process.env.INPUT_ATTEMPTS ?? "3", 3),
    delaysSeconds: parseDelays(
      process.env["INPUT_DELAYS-SECONDS"] ?? "5 15",
      [5, 15],
    ),
    statePath: process.env.GITHUB_STATE,
  });
  process.exit(code);
}
