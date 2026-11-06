import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = new URL("check-bridge-version.sh", import.meta.url).pathname;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const run = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Bridge Test",
      "-c",
      "user.email=bridge-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

const types = (version: number) =>
  `pub const BRIDGE_VERSION: u32 = ${String(version)};\n`;

// A desktop crate whose bridge calls account.rs; `change` edits files on a
// branch off main before the guard compares the two.
const guard = (change: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-version-"));
  roots.push(root);
  const source = path.join(root, "apps/desktop/src-tauri/src");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, "bridge.rs"),
    "fn authorize() { crate::account::authorize_bridge_request(); }\n",
  );
  writeFileSync(
    path.join(source, "account.rs"),
    "pub fn authorize_bridge_request() {}\n",
  );
  writeFileSync(path.join(source, "clipboard.rs"), "pub fn copy() {}\n");
  writeFileSync(path.join(source, "types.rs"), types(3));
  run(root, ["init", "--quiet", "--initial-branch=main"]);
  run(root, ["add", "."]);
  run(root, ["commit", "--quiet", "-m", "base"]);
  run(root, ["switch", "--quiet", "-c", "change"]);
  for (const [file, content] of Object.entries(change)) {
    writeFileSync(path.join(source, file), content);
  }
  run(root, ["commit", "--quiet", "--allow-empty", "-a", "-m", "change"]);
  const result = Bun.spawnSync(["bash", script], {
    cwd: root,
    env: { PATH: process.env["PATH"] ?? "", GITHUB_BASE_REF: "main" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
};

test("a change to a module the bridge calls needs a version bump", () => {
  const unbumped = guard({
    "account.rs": "pub fn authorize_bridge_request() { deny(); }\n",
  });
  expect(unbumped.exitCode).toBe(1);
  expect(unbumped.stderr).toContain("apps/desktop/src-tauri/src/account.rs");
  expect(
    guard({
      "account.rs": "pub fn authorize_bridge_request() { deny(); }\n",
      "types.rs": types(4),
    }).exitCode,
  ).toBe(0);
});

test("a module the bridge does not call needs no bump", () => {
  expect(
    guard({ "clipboard.rs": "pub fn copy() { paste(); }\n" }).exitCode,
  ).toBe(0);
});
