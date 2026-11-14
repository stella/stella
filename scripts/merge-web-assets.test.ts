import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
const script = path.join(import.meta.dir, "merge-web-assets.sh");
const validateImage = path.join(
  import.meta.dir,
  "validate-previous-web-image.sh",
);

test.each([
  [`ghcr.io/example/web@sha256:${"a".repeat(64)}`, 0],
  [`registry.example:5000/example/web:release@sha256:${"b".repeat(64)}`, 0],
  ["ghcr.io/example/web:latest", 1],
  [`ghcr.io/example/web@sha256:${"a".repeat(63)}`, 1],
  [`ghcr.io/example/web@sha256:${"A".repeat(64)}`, 1],
  [`ghcr.io/example/web@sha256:${"a".repeat(64)}\nother`, 1],
  ["runtime-base", 1],
  ["", 1],
])("validates immutable previous image %s", (image, exitCode) => {
  expect(Bun.spawnSync(["sh", validateImage, image]).exitCode).toBe(exitCode);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("copies only manifested assets without replacing the new build", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-web-assets-"));
  roots.push(root);
  const previous = path.join(root, "previous");
  const current = path.join(root, "current");
  mkdirSync(path.join(previous, "assets"), { recursive: true });
  mkdirSync(path.join(current, "assets"), { recursive: true });
  writeFileSync(path.join(previous, "assets/shared.js"), "previous");
  writeFileSync(path.join(previous, "assets/old.js"), "old");
  writeFileSync(path.join(previous, "assets/inherited.js"), "inherited");
  writeFileSync(path.join(current, "assets/shared.js"), "current");
  const manifest = path.join(root, "manifest");
  writeFileSync(manifest, "assets/shared.js\nassets/old.js\n");
  const copiedManifest = path.join(root, "copied-manifest");

  const result = Bun.spawnSync([
    "sh",
    script,
    previous,
    manifest,
    current,
    copiedManifest,
  ]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(path.join(current, "assets/shared.js"), "utf-8")).toBe(
    "current",
  );
  expect(readFileSync(path.join(current, "assets/old.js"), "utf-8")).toBe(
    "old",
  );
  expect(
    await Bun.file(path.join(current, "assets/inherited.js")).exists(),
  ).toBe(false);
  expect(readFileSync(copiedManifest, "utf-8")).toBe(
    "assets/shared.js\nassets/old.js\n",
  );
});

test("rejects manifest paths outside the asset directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-web-assets-"));
  roots.push(root);
  const manifest = path.join(root, "manifest");
  writeFileSync(manifest, "../outside.js\n");
  const result = Bun.spawnSync([
    "sh",
    script,
    root,
    manifest,
    path.join(root, "target"),
  ]);
  expect(result.exitCode).toBe(1);
});
