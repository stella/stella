import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const script = path.join(
  import.meta.dirname,
  "../.github/actions/cargo-deny/install.sh",
);
const version = "9.9.9";
const name = `cargo-deny-${version}-aarch64-apple-darwin`;
const binary = (reported: string) =>
  `#!/usr/bin/env bash\n[[ "$1" == "--version" ]] && echo "${reported}"\n`;

// Fake curl: serves the archive from a file, or fails like a transport error.
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
printf '%s\\n' "$url" >> "$DENY_TEST_REQUESTS"
[[ "$DENY_TEST_RELEASE" == "ok" ]] || exit 22
[[ "$url" == "https://release.invalid/${name}.tar.gz" ]] || exit 99
cp "$DENY_TEST_ARCHIVE" "$output"
`;

// Fake cargo: records the source build and installs a binary under --root.
const cargo = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DENY_TEST_CARGO"
root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$root/bin"
printf '%s' "$DENY_TEST_BUILT_BINARY" > "$root/bin/cargo-deny"
chmod +x "$root/bin/cargo-deny"
`;

type InstallOptions = {
  release: "ok" | "down";
  corrupt?: boolean;
  reported?: string;
  runner?: { os: string; arch: string };
};

const runInstall = ({
  release,
  corrupt = false,
  reported = `cargo-deny ${version}`,
  runner = { os: "macOS", arch: "ARM64" },
}: InstallOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cargo-deny-install-"));
  const home = path.join(directory, "home");
  const commands = path.join(directory, "commands");
  const staging = path.join(directory, "staging");
  const archive = path.join(directory, "archive.tar.gz");
  const requests = path.join(directory, "requests");
  const cargoCalls = path.join(directory, "cargo");
  const githubPath = path.join(directory, "github-path");
  try {
    mkdirSync(home);
    mkdirSync(commands);
    mkdirSync(path.join(staging, name), { recursive: true });
    writeFileSync(path.join(staging, name, "cargo-deny"), binary(reported));
    const tar = spawnSync("tar", ["-czf", archive, "-C", staging, name]);
    if (tar.status !== 0) {
      throw new Error(`tar failed: ${String(tar.stderr)}`);
    }
    const sha256 = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    if (corrupt) {
      writeFileSync(archive, "not the pinned archive");
    }
    writeFileSync(path.join(commands, "curl"), curl);
    writeFileSync(path.join(commands, "cargo"), cargo);
    chmodSync(path.join(commands, "curl"), 0o755);
    chmodSync(path.join(commands, "cargo"), 0o755);
    writeFileSync(requests, "");
    writeFileSync(cargoCalls, "");
    writeFileSync(githubPath, "");
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${commands}${path.delimiter}${process.env["PATH"] ?? ""}`,
        RUNNER_OS: runner.os,
        RUNNER_ARCH: runner.arch,
        GITHUB_PATH: githubPath,
        CARGO_DENY_VERSION: version,
        CARGO_DENY_SHA256: sha256,
        CARGO_DENY_RELEASE_URL: "https://release.invalid",
        DENY_TEST_RELEASE: release,
        DENY_TEST_ARCHIVE: archive,
        DENY_TEST_REQUESTS: requests,
        DENY_TEST_CARGO: cargoCalls,
        DENY_TEST_BUILT_BINARY: binary(reported),
      },
    });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      installed: existsSync(path.join(home, ".cargo-deny/bin/cargo-deny")),
      requests: readFileSync(requests, "utf-8"),
      cargoCalls: readFileSync(cargoCalls, "utf-8"),
      githubPath: readFileSync(githubPath, "utf-8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("cargo-deny binary trust boundary", () => {
  test("installs the verified release binary without a source build", () => {
    const result = runInstall({ release: "ok" });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.cargoCalls).toBe("");
    expect(result.output).toContain(`cargo-deny ${version}`);
    expect(result.githubPath).toContain("/.cargo-deny/bin");
  });

  test("rejects a corrupted archive without falling back or publishing PATH", () => {
    const result = runInstall({ release: "ok", corrupt: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("cargo-deny archive hash mismatch");
    expect(result.installed).toBe(false);
    expect(result.cargoCalls).toBe("");
    expect(result.githubPath).toBe("");
  });

  test("builds the pinned version from source only when transport fails", () => {
    const result = runInstall({ release: "down" });
    expect(result.status).toBe(0);
    expect(result.cargoCalls).toContain(
      `install cargo-deny --version ${version} --locked`,
    );
    expect(result.githubPath).toContain("/.cargo-deny/bin");
  });

  test("fails when the installed binary reports another version", () => {
    const result = runInstall({
      release: "ok",
      reported: "cargo-deny 0.0.1",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("expected 9.9.9");
    expect(result.githubPath).toBe("");
  });

  test("refuses a runner it has no pinned binary for", () => {
    const result = runInstall({
      release: "ok",
      runner: { os: "Linux", arch: "X64" },
    });
    expect(result.status).not.toBe(0);
    expect(result.requests).toBe("");
    expect(result.githubPath).toBe("");
  });
});
