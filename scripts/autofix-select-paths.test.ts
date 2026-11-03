import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectAutofixPaths } from "./autofix-select-paths";

describe("autofix path selection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-select-paths-"));
  const previous = process.cwd();
  const files = [
    "apps/api/src/server.ts",
    "apps/web/src/page.tsx",
    "apps/landing/src/page.ts",
    "docs/guide.md",
    ".github/workflows/ci.yml",
    "scripts/ratchet-baseline.json",
    ".changeset/README.md",
  ];

  beforeAll(() => {
    for (const file of files) {
      mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(root, file), "x\n");
    }
    mkdirSync(path.join(root, "apps/web/src/linked"), { recursive: true });
    symlinkSync(
      path.join(root, "apps/web/src/page.tsx"),
      path.join(root, "apps/web/src/linked/page.tsx"),
    );
    process.chdir(root);
  });

  afterAll(() => {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  });

  test("formats regular changed files and lints only non-landing sources", () => {
    expect(
      selectAutofixPaths([
        ...files,
        "apps/web/src/linked/page.tsx",
        "apps/web/src/deleted.ts",
      ]),
    ).toEqual({
      format: [
        "./apps/api/src/server.ts",
        "./apps/web/src/page.tsx",
        "./apps/landing/src/page.ts",
        "./docs/guide.md",
        "./.changeset/README.md",
      ],
      lint: ["./apps/api/src/server.ts", "./apps/web/src/page.tsx"],
    });
  });
});
