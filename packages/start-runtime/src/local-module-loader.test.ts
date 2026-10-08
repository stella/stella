import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadLocalModule } from "./local-module-loader";

describe("bounded local module loading", () => {
  test("imports relative, absolute and symlinked entries inside the real root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-module-"));
    const root = path.join(directory, "modules");
    try {
      await mkdir(root);
      const target = path.join(root, "inside space ž.mjs");
      await Bun.write(target, "export const value = 42;");
      await symlink(target, path.join(root, "alias.mjs"));
      await symlink(root, path.join(directory, "root-alias"));
      for (const modulePath of ["inside space ž.mjs", target, "alias.mjs"]) {
        expect(await loadLocalModule({ root, modulePath })).toMatchObject({
          status: "ok",
          value: { value: 42 },
        });
      }
      expect(
        await loadLocalModule({
          root: path.join(directory, "root-alias"),
          modulePath: "inside space ž.mjs",
        }),
      ).toMatchObject({ status: "ok", value: { value: 42 } });
      expect(
        await loadLocalModule({
          root: path.join(directory, "root-alias"),
          modulePath: target,
        }),
      ).toMatchObject({ status: "ok", value: { value: 42 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses parent segments, outside absolute paths and escaping symlinks before evaluation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "local-module-escape-"),
    );
    const root = path.join(directory, "modules");
    const outside = path.join(directory, "modules-outside");
    const marker = path.join(directory, "executed");
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await mkdir(outside);
      const target = path.join(outside, "outside.mjs");
      await Bun.write(
        target,
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export const value = 1;`,
      );
      await Bun.write(
        path.join(root, "inside.mjs"),
        "export const value = 42;",
      );
      await symlink(target, path.join(root, "escape.mjs"));
      await symlink(outside, path.join(root, "escape-dir"));
      for (const modulePath of [
        "../modules-outside/outside.mjs",
        "nested/../inside.mjs",
        "nested/..\\inside.mjs",
        target,
        "escape.mjs",
        "escape-dir/outside.mjs",
      ]) {
        expect(await loadLocalModule({ root, modulePath })).toMatchObject({
          status: "error",
          error: { code: "invalid-path" },
        });
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports resolution failures and rejects non-directory roots and non-file targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-module-errors-"));
    try {
      await Bun.write(
        path.join(root, "inside.mjs"),
        "export const value = 42;",
      );
      expect(
        await loadLocalModule({ root, modulePath: "missing.mjs" }),
      ).toMatchObject({
        status: "error",
        error: { code: "resolution-failed" },
      });
      expect(
        await loadLocalModule({
          root: path.join(root, "missing"),
          modulePath: "inside.mjs",
        }),
      ).toMatchObject({
        status: "error",
        error: { code: "resolution-failed" },
      });
      expect(
        await loadLocalModule({
          root: path.join(root, "inside.mjs"),
          modulePath: "",
        }),
      ).toMatchObject({ status: "error", error: { code: "invalid-path" } });
      expect(await loadLocalModule({ root, modulePath: "." })).toMatchObject({
        status: "error",
        error: { code: "invalid-path" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves module resolution and evaluation errors for the caller", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-module-evaluation-"));
    try {
      await Bun.write(
        path.join(root, "missing-dependency.mjs"),
        "import './missing.mjs';",
      );
      expect(
        await loadLocalModule({ root, modulePath: "missing-dependency.mjs" }),
      ).toMatchObject({
        status: "error",
        error: {
          code: "module-failed",
          cause: { code: "ERR_MODULE_NOT_FOUND" },
        },
      });
      await Bun.write(
        path.join(root, "throws.mjs"),
        "throw new TypeError('fixture evaluation failed');",
      );
      expect(
        await loadLocalModule({ root, modulePath: "throws.mjs" }),
      ).toMatchObject({
        status: "error",
        error: {
          code: "module-failed",
          cause: { name: "TypeError", message: "fixture evaluation failed" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
