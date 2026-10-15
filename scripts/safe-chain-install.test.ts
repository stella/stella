import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSha256 } from "@stll/sha256/node";

const script = path.join(
  import.meta.dirname,
  "../.github/actions/safe-chain/install.sh",
);
const primary = "https://primary.invalid/release";
const mirror = "https://mirror.invalid/release";
const hash = (contents: string) =>
  createSha256().update(contents).digest("hex");
const binary = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "setup-ci" ]]
touch "$SAFE_CHAIN_TEST_INSTALLED"
`;
const installer = `SHA256_LINUXSTATIC_X64="${hash(binary)}"\n`;

// The real transport is replaced, while the production installer still owns
// hash checks, cache checks, execution, and failure propagation.
const curl = `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$SAFE_CHAIN_TEST_REQUESTS"
case "$url" in
  https://primary.invalid/*)
    if [[ "$SAFE_CHAIN_TEST_PRIMARY" != "ok" ]]; then
      [[ "$SAFE_CHAIN_TEST_PRIMARY" == "binary-down" && "$url" == */install-safe-chain.sh ]] || exit 22
    fi
    source_dir="$SAFE_CHAIN_TEST_PRIMARY_DIR"
    ;;
  https://mirror.invalid/*)
    [[ "$SAFE_CHAIN_TEST_MIRROR" == "ok" ]] || exit 22
    source_dir="$SAFE_CHAIN_TEST_MIRROR_DIR"
    ;;
  *) exit 99 ;;
esac
cp "$source_dir/$(basename "$url")" "$output"
`;

type InstallOptions = {
  primaryStatus: "ok" | "down" | "binary-down";
  mirrorStatus: "ok" | "down";
  corrupt?: "installer" | "binary" | "primary-installer";
  cache?: "verified" | "poisoned";
};

const runInstall = ({
  primaryStatus,
  mirrorStatus,
  corrupt,
  cache,
}: InstallOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "safe-chain-install-"));
  const home = path.join(directory, "home");
  const commands = path.join(directory, "commands");
  const primaryDirectory = path.join(directory, "primary");
  const mirrorDirectory = path.join(directory, "mirror");
  const installed = path.join(directory, "installed");
  const requests = path.join(directory, "requests");
  const githubEnv = path.join(directory, "github-env");

  try {
    for (const target of [home, commands, primaryDirectory, mirrorDirectory]) {
      mkdirSync(target);
    }
    for (const target of [primaryDirectory, mirrorDirectory]) {
      writeFileSync(path.join(target, "install-safe-chain.sh"), installer);
      writeFileSync(path.join(target, "safe-chain-linuxstatic-x64"), binary);
    }
    if (corrupt === "installer") {
      writeFileSync(
        path.join(mirrorDirectory, "install-safe-chain.sh"),
        `${installer}# tampered\n`,
      );
    }
    if (corrupt === "binary") {
      writeFileSync(
        path.join(mirrorDirectory, "safe-chain-linuxstatic-x64"),
        `${binary}# tampered\n`,
      );
    }
    if (corrupt === "primary-installer") {
      writeFileSync(
        path.join(primaryDirectory, "install-safe-chain.sh"),
        `${installer}# tampered\n`,
      );
    }
    if (cache) {
      const cacheDirectory = path.join(home, ".safe-chain/bin");
      mkdirSync(cacheDirectory, { recursive: true });
      writeFileSync(
        path.join(cacheDirectory, "safe-chain"),
        cache === "verified" ? binary : `${binary}# tampered\n`,
      );
    }
    const fakeCurl = path.join(commands, "curl");
    writeFileSync(fakeCurl, curl);
    chmodSync(fakeCurl, 0o755);
    writeFileSync(requests, "");
    writeFileSync(githubEnv, "");

    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${commands}${path.delimiter}${process.env["PATH"] ?? ""}`,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        GITHUB_ENV: githubEnv,
        GITHUB_PATH: path.join(directory, "github-path"),
        SAFE_CHAIN_RELEASE_VERSION: "test-version",
        SAFE_CHAIN_SHA256: hash(installer),
        SAFE_CHAIN_PRIMARY_RELEASE_URL: primary,
        SAFE_CHAIN_MIRROR_RELEASE_URL: mirror,
        SAFE_CHAIN_TEST_PRIMARY: primaryStatus,
        SAFE_CHAIN_TEST_MIRROR: mirrorStatus,
        SAFE_CHAIN_TEST_PRIMARY_DIR: primaryDirectory,
        SAFE_CHAIN_TEST_MIRROR_DIR: mirrorDirectory,
        SAFE_CHAIN_TEST_INSTALLED: installed,
        SAFE_CHAIN_TEST_REQUESTS: requests,
      },
    });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      installed: existsSync(installed),
      githubEnv: readFileSync(githubEnv, "utf-8"),
      requests: readFileSync(requests, "utf-8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("Safe Chain download verification", () => {
  test("a cold cache installs verified mirror assets when upstream is down", () => {
    const result = runInstall({ primaryStatus: "down", mirrorStatus: "ok" });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.githubEnv).toContain(
      "SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=0",
    );
    expect(result.requests).toContain(`${mirror}/install-safe-chain.sh`);
    expect(result.requests).toContain(`${mirror}/safe-chain-linuxstatic-x64`);
  });

  for (const corrupt of ["installer", "binary"] as const) {
    test(`a modified mirror ${corrupt} fails before setup`, () => {
      const result = runInstall({
        primaryStatus: "down",
        mirrorStatus: "ok",
        corrupt,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`Safe Chain ${corrupt} hash mismatch`);
      expect(result.installed).toBe(false);
      expect(result.githubEnv).toBe("");
    });
  }

  test("a verified cache needs only the mirrored installer during an upstream outage", () => {
    const result = runInstall({
      primaryStatus: "down",
      mirrorStatus: "ok",
      cache: "verified",
    });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.requests).toEqual([
      `${primary}/install-safe-chain.sh`,
      `${mirror}/install-safe-chain.sh`,
    ]);
  });

  test("each asset can independently fall back to the mirror", () => {
    const result = runInstall({
      primaryStatus: "binary-down",
      mirrorStatus: "ok",
    });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.requests).toEqual([
      `${primary}/install-safe-chain.sh`,
      `${primary}/safe-chain-linuxstatic-x64`,
      `${mirror}/safe-chain-linuxstatic-x64`,
    ]);
  });

  test("upstream hash corruption fails without consulting the mirror", () => {
    const result = runInstall({
      primaryStatus: "ok",
      mirrorStatus: "ok",
      corrupt: "primary-installer",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Safe Chain installer hash mismatch");
    expect(result.installed).toBe(false);
    expect(result.requests).toEqual([`${primary}/install-safe-chain.sh`]);
  });

  test("successful upstream downloads never contact the mirror", () => {
    const result = runInstall({ primaryStatus: "ok", mirrorStatus: "down" });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.requests).toEqual([
      `${primary}/install-safe-chain.sh`,
      `${primary}/safe-chain-linuxstatic-x64`,
    ]);
  });

  test("an outage at both sources fails instead of skipping installation", () => {
    const result = runInstall({ primaryStatus: "down", mirrorStatus: "down" });
    expect(result.status).not.toBe(0);
    expect(result.requests).toEqual([
      `${primary}/install-safe-chain.sh`,
      `${mirror}/install-safe-chain.sh`,
    ]);
    expect(result.installed).toBe(false);
    expect(result.githubEnv).toBe("");
  });

  test("a restored cache is verified before execution", () => {
    const result = runInstall({
      primaryStatus: "ok",
      mirrorStatus: "ok",
      cache: "poisoned",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Safe Chain binary hash mismatch");
    expect(result.requests).toEqual([`${primary}/install-safe-chain.sh`]);
    expect(result.installed).toBe(false);
    expect(result.githubEnv).toBe("");
  });
});
