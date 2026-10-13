import { describe, expect, test } from "bun:test";
import path from "node:path";

import { isPathInside, isPathStrictlyInside, repoRelativePath } from "./index";

describe("repository-relative identifiers", () => {
  test("use forward slashes for POSIX paths", () => {
    expect(repoRelativePath("/repo", "/repo/a/b.ts", path.posix)).toBe(
      "a/b.ts",
    );
  });

  test("use forward slashes for Windows paths", () => {
    expect(repoRelativePath("C:\\repo", "C:\\repo\\a\\b.ts", path.win32)).toBe(
      "a/b.ts",
    );
  });

  test("uses the current platform by default", () => {
    expect(
      repoRelativePath(
        path.join(path.sep, "repo"),
        path.join(path.sep, "repo", "a", "b.ts"),
      ),
    ).toBe("a/b.ts");
  });
});

describe("strict path containment", () => {
  test.each([
    ["equal POSIX paths", "/pkg/dist", "/pkg/dist", path.posix, false],
    [
      "normalized POSIX equality",
      "/pkg/dist",
      "/pkg/dist/.",
      path.posix,
      false,
    ],
    [
      "equal Windows paths",
      "C:\\pkg\\dist",
      "C:\\pkg\\dist",
      path.win32,
      false,
    ],
    [
      "differently cased Windows equality",
      "C:\\pkg\\dist",
      "C:\\pkg\\DIST",
      path.win32,
      false,
    ],
    [
      "a differently cased POSIX directory",
      "/pkg/dist",
      "/pkg/DIST",
      path.posix,
      false,
    ],
    [
      "a differently cased POSIX child",
      "/pkg/dist",
      "/pkg/dist/DIST",
      path.posix,
      true,
    ],
    ["a POSIX child", "/pkg/dist", "/pkg/dist/a.ts", path.posix, true],
    [
      "a Windows child",
      "C:\\pkg\\dist",
      "C:\\pkg\\dist\\a.ts",
      path.win32,
      true,
    ],
    [
      "a POSIX sibling prefix",
      "/pkg/dist",
      "/pkg/dist-cache",
      path.posix,
      false,
    ],
    [
      "a Windows sibling prefix",
      "C:\\pkg\\dist",
      "C:\\pkg\\dist-cache",
      path.win32,
      false,
    ],
    [
      "a POSIX parent escape",
      "/pkg/dist",
      "/pkg/dist/../a.ts",
      path.posix,
      false,
    ],
    [
      "a Windows parent escape",
      "C:\\pkg\\dist",
      "C:\\pkg\\dist\\..\\a.ts",
      path.win32,
      false,
    ],
    [
      "a different Windows drive",
      "C:\\pkg\\dist",
      "D:\\pkg\\dist\\a.ts",
      path.win32,
      false,
    ],
  ] as const)("classifies %s", (_name, root, candidate, pathApi, expected) => {
    expect(isPathStrictlyInside(root, candidate, pathApi)).toBe(expected);
  });

  test("uses the current platform by default", () => {
    const root = path.join(path.sep, "pkg", "dist");
    expect(isPathStrictlyInside(root, root)).toBe(false);
    expect(isPathStrictlyInside(root, path.join(root, "a.ts"))).toBe(true);
  });

  test("POSIX casing identifies different directories", () => {
    expect(path.posix.relative("/pkg/dist", "/pkg/DIST")).not.toBe("");
    expect(isPathStrictlyInside("/pkg", "/pkg/DIST", path.posix)).toBe(true);
  });
});

describe("path containment", () => {
  test.each([
    ["equal POSIX paths", "/safe/root", "/safe/root", path.posix, true],
    ["a POSIX descendant", "/safe/root", "/safe/root/a.ts", path.posix, true],
    [
      "a POSIX sibling prefix",
      "/safe/root",
      "/safe/root-backup",
      path.posix,
      false,
    ],
    [
      "a POSIX parent escape",
      "/safe/root",
      "/safe/root/../a.ts",
      path.posix,
      false,
    ],
    [
      "equal Windows paths",
      "C:\\safe\\root",
      "C:\\safe\\root",
      path.win32,
      true,
    ],
    [
      "a Windows descendant",
      "C:\\safe\\root",
      "C:\\safe\\root\\a.ts",
      path.win32,
      true,
    ],
    [
      "a Windows sibling prefix",
      "C:\\safe\\root",
      "C:\\safe\\root-backup",
      path.win32,
      false,
    ],
    [
      "a Windows parent escape",
      "C:\\safe\\root",
      "C:\\safe\\root\\..\\a.ts",
      path.win32,
      false,
    ],
    [
      "a different Windows drive",
      "C:\\safe\\root",
      "D:\\safe\\root\\a.ts",
      path.win32,
      false,
    ],
  ] as const)("classifies %s", (_name, root, candidate, pathApi, expected) => {
    expect(isPathInside(root, candidate, pathApi)).toBe(expected);
  });
});
