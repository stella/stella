import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

const channel = (file: string): string => {
  const match = /^channel = "([^"]+)"$/mu.exec(
    readFileSync(path.join(root, file), "utf-8"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`${file} declares no toolchain channel`);
  }
  return match[1];
};

const workflowToolchains = () =>
  [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((file) =>
    [
      ...readFileSync(path.join(root, file), "utf-8").matchAll(
        /^\s+(?:toolchain|RUSTUP_TOOLCHAIN): (\S+)$/gmu,
      ),
    ].flatMap(([line, version]) =>
      version === undefined ? [] : [{ file, line: line.trim(), version }],
    ),
  );

test("Rust toolchains are exact versions, never a floating channel", () => {
  const toolchainFiles = [
    ...new Bun.Glob(
      "{apps,packages}/*/{,src-tauri/}rust-toolchain.toml",
    ).scanSync({ cwd: root }),
  ];
  expect(toolchainFiles.length).toBeGreaterThan(0);
  for (const file of toolchainFiles) {
    expect(channel(file), file).toMatch(EXACT_VERSION);
  }
  const uses = workflowToolchains();
  expect(uses.length).toBeGreaterThan(0);
  for (const { file, line, version } of uses) {
    expect(version, `${file}: ${line}`).toMatch(EXACT_VERSION);
  }
});

test("workflows build the desktop crate with its own pinned toolchain", () => {
  const desktop = channel("apps/desktop/src-tauri/rust-toolchain.toml");
  const scanEngine = channel("packages/scan-engine/rust-toolchain.toml");
  for (const { file, line, version } of workflowToolchains()) {
    expect([desktop, scanEngine], `${file}: ${line}`).toContain(version);
  }
});
