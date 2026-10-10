import { describe, expect, test } from "bun:test";
import path from "node:path";

import { isPathInside, repoRelativePath } from "./index";

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
