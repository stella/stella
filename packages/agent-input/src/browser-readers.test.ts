import { panic } from "better-result";
import { expect, test } from "bun:test";
import path from "node:path";

import packageManifest from "../package.json";

test("published reader subpaths bundle for browsers", async () => {
  const packageRoot = path.resolve(import.meta.dir, "..");
  const entrypoints = Object.entries(packageManifest.exports).flatMap(
    ([subpath, target]) =>
      subpath !== "." && typeof target === "string"
        ? [path.resolve(packageRoot, target)]
        : [],
  );

  if (entrypoints.length === 0) {
    panic("agent-input has no browser reader subpaths to bundle");
  }
  const result = await Bun.build({
    entrypoints,
    target: "browser",
  });
  expect(result.success).toBe(true);
  expect(result.logs.filter(({ level }) => level === "error")).toEqual([]);
});
