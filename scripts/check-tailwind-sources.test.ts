import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findUnscannedClassPackages } from "./check-tailwind-sources.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

// A repo with one app that renders `markdown-ui` (ships utilities through
// tailwind-merge), which in turn renders `nested-ui`; `date-lib` ships none.
const makeRepo = (css: string): { root: string; entry: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "tailwind-sources-"));
  roots.push(root);
  writeJson(path.join(root, "apps/web/package.json"), {
    dependencies: { "date-lib": "1", "markdown-ui": "1", tailwindcss: "4" },
  });
  writeJson(path.join(root, "node_modules/date-lib/package.json"), {});
  writeJson(path.join(root, "node_modules/tailwindcss/package.json"), {});
  writeJson(path.join(root, "node_modules/markdown-ui/package.json"), {
    dependencies: { "nested-ui": "1", "tailwind-merge": "3" },
  });
  writeJson(path.join(root, "node_modules/nested-ui/package.json"), {
    peerDependencies: { tailwindcss: "4" },
  });
  const entry = path.join(root, "apps/web/src/app.css");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, `@import "tailwindcss";\n${css}`);
  return { root, entry };
};

const unscanned = (css: string): string[] => {
  const { root, entry } = makeRepo(css);
  return findUnscannedClassPackages(entry, root).map(
    (finding) => finding.dependency,
  );
};

test("reports class-shipping dependencies, direct and nested, with no @source", () => {
  expect(unscanned("")).toEqual(["markdown-ui", "nested-ui"]);
});

test("accepts an @source glob inside each package", () => {
  expect(
    unscanned(
      [
        `@source "../../../node_modules/markdown-ui/dist/**/*.js";`,
        `@source "../../../node_modules/nested-ui";`,
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("an @source elsewhere or an excluding @source does not count", () => {
  expect(
    unscanned(
      [
        `@source "../../../node_modules/markdown-ui-extra/**/*.js";`,
        `@source not "../../../node_modules/nested-ui/**";`,
        `@source "../../../node_modules/nested-ui/dist/**/*.js";`,
      ].join("\n"),
    ),
  ).toEqual(["markdown-ui"]);
});
