import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleepMs } from "node:timers/promises";

import { childExitStatus } from "../packages/scripts/src/child-exit-status.ts";

const NON_RETRYABLE_AUTH_ERROR =
  /incorrect username or password|invalid username or password|bad credentials/iu;

export const isNonRetryableLoginError = (output: string): boolean =>
  NON_RETRYABLE_AUTH_ERROR.test(output);

const escapeCommandData = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const maskSecret = (secret: string): void => {
  for (const line of secret.split(/\r?\n/u)) {
    if (line.length > 0) {
      process.stdout.write(`::add-mask::${escapeCommandData(line)}\n`);
    }
  }
};

const parsePositiveInt = (raw: string, fallback: number): number => {
  const trimmed = raw.trim();
  if (!trimmed || !/^[1-9][0-9]*$/u.test(trimmed)) {
    return fallback;
  }
  return Number(trimmed);
};

const parseDelays = (raw: string, fallback: readonly number[]): number[] => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [...fallback];
  }
  const parts = trimmed.split(/\s+/u);
  if (parts.some((part) => !/^[0-9]+$/u.test(part))) {
    return [...fallback];
  }
  return parts.map(Number);
};

const defaultSleep = async (seconds: number): Promise<void> => {
  if (seconds <= 0) {
    return;
  }
  await sleepMs(seconds * 1000);
};

const saveState = (
  statePath: string | undefined,
  entries: Readonly<Record<string, string>>,
): void => {
  if (!statePath) {
    return;
  }
  const lines = Object.entries(entries).map(([key, value]) => {
    const clean = value.replaceAll("\r", "").replaceAll("\n", "");
    return `${key}=${clean}\n`;
  });
  appendFileSync(statePath, lines.join(""), "utf-8");
};

export type DockerLoginOptions = {
  registry?: string;
  username: string;
  password: string;
  logout?: string;
  attempts?: number;
  delaysSeconds?: readonly number[];
  statePath?: string | undefined;
  dockerBin?: string;
  sleep?: (seconds: number) => Promise<void>;
};

export const runDockerLogin = async (
  options: DockerLoginOptions,
): Promise<number> => {
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
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    if (result.error) {
      process.stderr.write(
        `docker-login: spawn failed: ${result.error.message}\n`,
      );
    }

    const status = childExitStatus(result);
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

    const combined = `${result.stdout}\n${result.stderr}`;
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
};

export type DockerLogoutOptions = {
  loggedIn?: string | undefined;
  registry?: string | undefined;
  logout?: string | undefined;
  dockerBin?: string | undefined;
};

export const runDockerLogout = (options: DockerLogoutOptions): number => {
  if (options.loggedIn !== "true" || options.logout === "false") {
    return 0;
  }
  const registry = (options.registry ?? "").trim();
  const dockerBin = options.dockerBin ?? "docker";
  const args = registry ? ["logout", registry] : ["logout"];
  const result = spawnSync(dockerBin, args, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const status = childExitStatus(result);
  if (status !== 0) {
    const target = registry || "Docker Hub";
    process.stderr.write(
      `::warning::docker logout ${target} exited with status ${status}\n`,
    );
  }
  return 0;
};

export const runDockerLoginFromEnv = async (): Promise<void> => {
  process.exitCode = childExitStatus(
    await runDockerLogin({
      registry: process.env["INPUT_REGISTRY"] ?? "",
      username: process.env["INPUT_USERNAME"] ?? "",
      password: process.env["INPUT_PASSWORD"] ?? "",
      logout: process.env["INPUT_LOGOUT"] ?? "true",
      attempts: parsePositiveInt(process.env["INPUT_ATTEMPTS"] ?? "3", 3),
      delaysSeconds: parseDelays(
        process.env["INPUT_DELAYS-SECONDS"] ?? "5 15",
        [5, 15],
      ),
      statePath: process.env["GITHUB_STATE"],
    }),
  );
};

export const runDockerLogoutFromEnv = (): void => {
  process.exitCode = runDockerLogout({
    loggedIn: process.env["STATE_logged_in"],
    registry: process.env["STATE_registry"],
    logout: process.env["STATE_logout"],
  });
};

if (import.meta.main) {
  await runDockerLoginFromEnv();
}
