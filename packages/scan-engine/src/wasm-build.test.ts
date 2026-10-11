import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const toolchain = readFileSync(
  new URL("../rust-toolchain.toml", import.meta.url),
  "utf-8",
);
const pinnedVersion = /^channel = "([^"]+)"/mu.exec(toolchain)?.at(1);
if (pinnedVersion === undefined) {
  panic("Missing pinned scan engine Rust version");
}

const buildWithCompiler = (metadata: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "scan-engine-compiler-"));
  try {
    writeFileSync(
      path.join(directory, "rustc"),
      `#!/bin/sh\nif [ "$1" = "-vV" ]; then\n  printf '%s\\n' '${metadata}'\nelse\n  exit 37\nfi\n`,
      { mode: 0o755 },
    );
    return Bun.spawnSync(
      ["bash", new URL("../scripts/build-wasm.sh", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"]}`,
          CARGO_HOME: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("WASM generation rejects every noncanonical compiler before building", () => {
  for (const host of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
  ]) {
    const result = buildWithCompiler(
      `host: ${host}\nrelease: ${pinnedVersion}`,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "generation requires x86_64 Linux",
    );
  }
  const wrongVersion = buildWithCompiler(
    "host: x86_64-unknown-linux-gnu\nrelease: 0.0.0",
  );
  expect(wrongVersion.exitCode).toBe(2);
  expect(wrongVersion.stderr.toString()).toContain(`Rust ${pinnedVersion}`);
});

test("canonical compiler reaches the build preparation", () => {
  const result = buildWithCompiler(
    `host: x86_64-unknown-linux-gnu\nrelease: ${pinnedVersion}`,
  );
  expect(result.exitCode).toBe(37);
  expect(result.stderr.toString()).not.toContain("generation requires");
});
