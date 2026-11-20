import { expect, test } from "bun:test";
import path from "node:path";

import { resolveMetafilePath } from "./metafile-path";

test("a metafile path on another drive resolves to that drive", () => {
  const file = resolveMetafilePath(
    "../../../../C:/cache/links/pkg/index.js",
    "/repo/packages/app",
  );
  expect(file.replaceAll("\\", "/")).toBe("C:/cache/links/pkg/index.js");
});

test("a relative metafile path resolves from its base", () => {
  expect(resolveMetafilePath("../lib/index.js", "/repo/packages/app")).toBe(
    path.resolve("/repo/packages/app", "../lib/index.js"),
  );
});

test("a metafile path defaults to the working directory", () => {
  expect(resolveMetafilePath("src/index.ts")).toBe(
    path.resolve("src/index.ts"),
  );
});
