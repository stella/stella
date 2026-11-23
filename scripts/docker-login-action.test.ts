import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isNonRetryableLoginError,
  runDockerLogin,
} from "../.github/actions/docker-login/main.mjs";
import { runDockerLogout } from "../.github/actions/docker-login/post.mjs";

function makeFakeDocker(dir: string, scriptBody: string): string {
  const bin = path.join(dir, "docker");
  writeFileSync(bin, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe(".github/actions/docker-login", () => {
  test("classifies invalid credentials as non-retryable and transient DNS errors as retryable", () => {
    expect(
      isNonRetryableLoginError(
        'Error response from daemon: Get "https://ghcr.io/v2/": unauthorized: incorrect username or password',
      ),
    ).toBe(true);
    expect(isNonRetryableLoginError("bad credentials")).toBe(true);
    expect(
      isNonRetryableLoginError(
        'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: i/o timeout',
      ),
    ).toBe(false);
  });

  test("retries transient registry errors, passes password on stdin, and records logout state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docker-login-test-"));
    try {
      const counterFile = path.join(dir, "attempts");
      const argsFile = path.join(dir, "args");
      const stdinFile = path.join(dir, "stdin");
      const stateFile = path.join(dir, "state");
      const dockerBin = makeFakeDocker(
        dir,
        `
count=0
if [[ -f "${counterFile}" ]]; then
  count=$(cat "${counterFile}")
fi
count=$((count + 1))
echo "$count" > "${counterFile}"
printf '%s\n' "$@" > "${argsFile}"
cat > "${stdinFile}"
if (( count == 1 )); then
  echo 'Error response from daemon: dial tcp: lookup ghcr.io: i/o timeout' >&2
  exit 1
fi
echo 'Login Succeeded'
`,
      );

      const delays: number[] = [];
      const code = await runDockerLogin({
        registry: "ghcr.io",
        username: "octocat",
        password: "secret-token-value",
        attempts: 3,
        delaysSeconds: [5, 15],
        statePath: stateFile,
        dockerBin,
        sleep: async (seconds: number) => {
          delays.push(seconds);
        },
      });

      expect(code).toBe(0);
      expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
      expect(delays).toEqual([5]);
      expect(readFileSync(argsFile, "utf-8").trim().split("\n")).toEqual([
        "login",
        "--username",
        "octocat",
        "--password-stdin",
        "ghcr.io",
      ]);
      expect(readFileSync(stdinFile, "utf-8").trim()).toBe(
        "secret-token-value",
      );
      expect(readFileSync(stateFile, "utf-8")).toContain("logged_in=true\n");
      expect(readFileSync(stateFile, "utf-8")).toContain("registry=ghcr.io\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails fast without retrying on invalid credentials", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docker-login-auth-"));
    try {
      const counterFile = path.join(dir, "attempts");
      const dockerBin = makeFakeDocker(
        dir,
        `
count=0
if [[ -f "${counterFile}" ]]; then
  count=$(cat "${counterFile}")
fi
count=$((count + 1))
echo "$count" > "${counterFile}"
cat >/dev/null
echo 'Error: incorrect username or password' >&2
exit 1
`,
      );

      const delays: number[] = [];
      const code = await runDockerLogin({
        registry: "ghcr.io",
        username: "octocat",
        password: "bad-password",
        attempts: 3,
        delaysSeconds: [5, 15],
        dockerBin,
        sleep: async (seconds: number) => {
          delays.push(seconds);
        },
      });

      expect(code).toBe(1);
      expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
      expect(delays).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("post step logs out only when login succeeded and logout is enabled", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docker-logout-test-"));
    try {
      const logFile = path.join(dir, "logout-args");
      const dockerBin = makeFakeDocker(
        dir,
        `printf '%s\n' "$@" >> "${logFile}"`,
      );

      expect(
        runDockerLogout({
          loggedIn: "false",
          registry: "ghcr.io",
          logout: "true",
          dockerBin,
        }),
      ).toBe(0);
      expect(
        runDockerLogout({
          loggedIn: "true",
          registry: "ghcr.io",
          logout: "false",
          dockerBin,
        }),
      ).toBe(0);
      expect(
        runDockerLogout({
          loggedIn: "true",
          registry: "ghcr.io",
          logout: "true",
          dockerBin,
        }),
      ).toBe(0);

      expect(readFileSync(logFile, "utf-8").trim().split("\n")).toEqual([
        "logout",
        "ghcr.io",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
