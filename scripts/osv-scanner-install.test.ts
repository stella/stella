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
  "../.github/actions/osv-scanner/install.sh",
);
const binary =
  '#!/usr/bin/env bash\n[[ "$1" == "--version" ]]\ntouch "$OSV_TEST_EXECUTED"\n';
const sha256 = createSha256().update(binary).digest("hex");
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
printf '%s\\n' "$url" >> "$OSV_TEST_REQUESTS"
case "$url" in
  https://primary.invalid/*)
    [[ "$OSV_TEST_PRIMARY" == "ok" ]] || exit 22
    cp "$OSV_TEST_PRIMARY_FILE" "$output" ;;
  https://mirror.invalid/*)
    [[ "$OSV_TEST_MIRROR" == "ok" ]] || exit 22
    cp "$OSV_TEST_MIRROR_FILE" "$output" ;;
  *) exit 99 ;;
esac
`;

type InstallOptions = {
  primary: "ok" | "down";
  mirror: "ok" | "down";
  corrupt?: "primary" | "mirror" | "cache";
  cache?: "verified";
};

const runInstall = ({ primary, mirror, corrupt, cache }: InstallOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "osv-install-"));
  const home = path.join(directory, "home");
  const commands = path.join(directory, "commands");
  const requests = path.join(directory, "requests");
  const githubPath = path.join(directory, "github-path");
  const executed = path.join(directory, "executed");
  const primaryFile = path.join(directory, "primary");
  const mirrorFile = path.join(directory, "mirror");
  try {
    mkdirSync(home);
    mkdirSync(commands);
    writeFileSync(
      primaryFile,
      corrupt === "primary" ? `${binary}# corrupt\n` : binary,
    );
    writeFileSync(
      mirrorFile,
      corrupt === "mirror" ? `${binary}# corrupt\n` : binary,
    );
    if (cache || corrupt === "cache") {
      mkdirSync(path.join(home, ".osv-scanner/bin"), { recursive: true });
      writeFileSync(
        path.join(home, ".osv-scanner/bin/osv-scanner"),
        corrupt === "cache" ? `${binary}# corrupt\n` : binary,
      );
    }
    writeFileSync(path.join(commands, "curl"), curl);
    chmodSync(path.join(commands, "curl"), 0o755);
    writeFileSync(requests, "");
    writeFileSync(githubPath, "");
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${commands}${path.delimiter}${process.env["PATH"] ?? ""}`,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        GITHUB_PATH: githubPath,
        OSV_SCANNER_RELEASE_VERSION: "test",
        OSV_SCANNER_SHA256: sha256,
        OSV_SCANNER_PRIMARY_RELEASE_URL: "https://primary.invalid/release",
        OSV_SCANNER_MIRROR_RELEASE_URL: "https://mirror.invalid/release",
        OSV_TEST_PRIMARY: primary,
        OSV_TEST_MIRROR: mirror,
        OSV_TEST_PRIMARY_FILE: primaryFile,
        OSV_TEST_MIRROR_FILE: mirrorFile,
        OSV_TEST_EXECUTED: executed,
        OSV_TEST_REQUESTS: requests,
      },
    });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      executed: existsSync(executed),
      requests: readFileSync(requests, "utf-8"),
      githubPath: readFileSync(githubPath, "utf-8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("OSV-Scanner binary trust boundary", () => {
  test("installs the verified mirror when upstream transport fails", () => {
    const result = runInstall({ primary: "down", mirror: "ok" });
    expect(result.status).toBe(0);
    expect(result.executed).toBe(true);
    expect(result.requests).toContain(
      "https://mirror.invalid/release/osv-scanner_linux_amd64",
    );
    expect(result.githubPath).toContain("/.osv-scanner/bin");
  });

  for (const corrupt of ["primary", "mirror", "cache"] as const) {
    test(`rejects a corrupted ${corrupt} before execution or PATH publication`, () => {
      const result = runInstall({
        primary: corrupt === "mirror" ? "down" : "ok",
        mirror: "ok",
        corrupt,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("OSV-Scanner binary hash mismatch");
      expect(result.executed).toBe(false);
      expect(result.githubPath).toBe("");
      if (corrupt === "primary") {
        expect(result.requests).not.toContain("mirror.invalid");
      }
    });
  }

  test("does not depend on transport when a verified binary is cached", () => {
    const result = runInstall({
      primary: "down",
      mirror: "down",
      cache: "verified",
    });
    expect(result.status).toBe(0);
    expect(result.executed).toBe(true);
    expect(result.requests).toBe("");
  });

  test("fails when both download sources fail", () => {
    const result = runInstall({ primary: "down", mirror: "down" });
    expect(result.status).not.toBe(0);
    expect(result.executed).toBe(false);
    expect(result.githubPath).toBe("");
  });
});
