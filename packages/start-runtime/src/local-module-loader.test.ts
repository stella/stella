import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isWithinRoot, loadLocalModule } from "./local-module-loader";

describe("filesystem root containment", () => {
  test("accepts descendants of POSIX and Windows filesystem roots", () => {
    expect(isWithinRoot({ pathApi: path.posix, root: "/", target: "/" })).toBe(
      true,
    );
    expect(
      isWithinRoot({ pathApi: path.posix, root: "/", target: "/a/b.mjs" }),
    ).toBe(true);
    expect(
      isWithinRoot({
        pathApi: path.win32,
        root: "C:\\",
        target: "C:\\a\\b.mjs",
      }),
    ).toBe(true);
  });

  test("uses platform case semantics for descendant paths", () => {
    for (const target of [
      "c:\\modules\\a.mjs",
      "C:\\MODULES\\sub\\b.mjs",
      "C:\\modules\\..cache\\x.mjs",
    ]) {
      expect(
        isWithinRoot({ pathApi: path.win32, root: "C:\\modules", target }),
      ).toBe(true);
    }
    for (const target of [
      "C:\\modules-other\\a.mjs",
      "C:\\a.mjs",
      "D:\\modules\\a.mjs",
    ]) {
      expect(
        isWithinRoot({ pathApi: path.win32, root: "C:\\modules", target }),
      ).toBe(false);
    }
    expect(
      isWithinRoot({
        pathApi: path.posix,
        root: "/mods",
        target: "/MODS/a.mjs",
      }),
    ).toBe(false);
  });

  test("rejects other roots, sibling prefixes and parent traversal", () => {
    expect(
      isWithinRoot({
        pathApi: path.win32,
        root: "C:\\",
        target: "D:\\a.mjs",
      }),
    ).toBe(false);
    expect(
      isWithinRoot({
        pathApi: path.posix,
        root: "/modules",
        target: "/modules-backup/a.mjs",
      }),
    ).toBe(false);
    expect(
      isWithinRoot({
        pathApi: path.posix,
        root: "/modules",
        target: "/modules/../a.mjs",
      }),
    ).toBe(false);
  });
});

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

  test("loads only files whose real path is inside the declared root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-module-root-"));
    const root = path.join(directory, "modules");
    const sibling = path.join(directory, "modules-backup");
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await mkdir(sibling);
      const siblingModule = path.join(sibling, "value.mjs");
      await Bun.write(siblingModule, "export const value = 1;");
      await Bun.write(
        path.join(root, "inside.mjs"),
        "export const value = 42;",
      );
      await symlink(siblingModule, path.join(root, "linked.mjs"));
      for (const modulePath of [
        "../modules-backup/value.mjs",
        "nested/../inside.mjs",
        siblingModule,
        "linked.mjs",
      ]) {
        expect(await loadLocalModule({ root, modulePath })).toMatchObject({
          status: "error",
          error: { code: "invalid-path" },
        });
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
