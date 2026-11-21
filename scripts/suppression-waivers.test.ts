import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanSourceFiles } from "./source-globs";
import {
  observeSecurityDirectives,
  readWalkedSource,
} from "./suppression-waivers";

const WAIVED_SOURCE = [
  "export const listExample = async () => {",
  "  // eslint-disable-next-line security-guards/no-unscoped-user-query -- audit rows are already org-scoped",
  "  return await db.select().from(user);",
  "};",
  "",
].join("\n");

const writeSource = (root: string, file: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), WAIVED_SOURCE);
};

const observe = (root: string, files: readonly string[]) =>
  observeSecurityDirectives(files, (file) => readWalkedSource(root, file));

test("a walked file that vanishes before it is read carries no waiver", () => {
  const root = mkdtempSync(path.join(tmpdir(), "suppression-waivers-"));
  try {
    writeSource(root, "scripts/kept.ts");
    writeSource(root, "scripts/removed.ts");
    writeSource(root, "scripts/fixture-dir/inside.ts");
    const walked = scanSourceFiles(root);
    expect(walked).toEqual([
      "scripts/fixture-dir/inside.ts",
      "scripts/kept.ts",
      "scripts/removed.ts",
    ]);
    // Another check removes a file and replaces a directory with a file
    // between this walk and the reads.
    rmSync(path.join(root, "scripts/removed.ts"));
    rmSync(path.join(root, "scripts/fixture-dir"), { recursive: true });
    writeFileSync(path.join(root, "scripts/fixture-dir"), "");

    const { observed, bare } = observe(root, walked);
    expect(observed.map(({ file }) => file)).toEqual(["scripts/kept.ts"]);
    expect(bare).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a walked path that cannot be read for another reason still fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "suppression-waivers-"));
  try {
    mkdirSync(path.join(root, "scripts/now-a-directory.ts"), {
      recursive: true,
    });
    expect(() => observe(root, ["scripts/now-a-directory.ts"])).toThrow(
      "EISDIR",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
