import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createTestTmpDir, useTestTmpDir, withTestTmpDir } from "./tmp.ts";

describe("test temp dirs", () => {
  test("each directory is fresh and removed when its scope ends", async () => {
    const seen: string[] = [];
    await withTestTmpDir(async (dir) => {
      seen.push(dir.path);
      await writeFile(dir.join("a.txt"), "a");
      expect(await readFile(dir.join("a.txt"), "utf-8")).toBe("a");
    });
    await withTestTmpDir((dir) => {
      seen.push(dir.path);
    });
    expect(new Set(seen).size).toBe(2);
    expect(seen.some((dir) => existsSync(dir))).toBe(false);
  });

  test("the directory is removed when the body throws", async () => {
    let created = "";
    const failing = withTestTmpDir((dir) => {
      created = dir.path;
      throw new Error("body failed");
    });
    expect(String(await rejectionOf(failing))).toContain("body failed");
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });

  test("join refuses paths that leave the directory", async () => {
    await using dir = await createTestTmpDir();
    expect(dir.join("nested", "file")).toStartWith(dir.path);
    expect(() => dir.join("..", "elsewhere")).toThrow("escapes");
    expect(() => dir.join("/etc/passwd")).toThrow("escapes");
  });

  test("refuses a prefix that is not short kebab-case", async () => {
    expect(String(await rejectionOf(createTestTmpDir("../up")))).toContain(
      "kebab-case",
    );
  });
});

describe("per-test temp dir hooks", () => {
  const tmp = useTestTmpDir("kit-hook");
  const paths: string[] = [];

  test("first test gets its own directory", async () => {
    paths.push(tmp().path);
    await writeFile(tmp().join("left-over"), "x");
  });

  test("the next test gets a different, empty one", () => {
    paths.push(tmp().path);
    expect(paths[0]).not.toBe(paths[1]);
    expect(existsSync(paths[0] ?? "")).toBe(false);
    expect(existsSync(tmp().join("left-over"))).toBe(false);
  });
});
