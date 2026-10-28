import { expect, test } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";

import { repoRoot, trackedRepoFiles } from "./oxlint-config-scopes";

// Every tracked regular file, so instruction sources and their generated
// copies count too; recorded merge-group history is the only exception.
// Submodule gitlinks and symlinks are not regular files and are skipped.
const fixtureRoot = "scripts/fixtures/merge-group-ejections/";
const retiredNames = [
  ["STELLA", "MERGE", "HOLD"].join("_"),
  ["MERGE", "HOLD"].join("_"),
].map((name) => Buffer.from(name));

test("tracked files contain no retired merge-hold variables", () => {
  const offenders: string[] = [];
  const scanned = new Set<string>();
  for (const file of trackedRepoFiles()) {
    if (file.startsWith(fixtureRoot)) {
      continue;
    }
    const path = `${repoRoot}/${file}`;
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    scanned.add(file);
    const source = readFileSync(path);
    if (retiredNames.some((name) => source.includes(name))) {
      offenders.push(file);
    }
  }

  // The instruction source and its generated copy were the last files a
  // root-limited census missed; fail if they ever drop out of the scan.
  expect(scanned.has(".ai/local/agents.md")).toBe(true);
  expect(scanned.has("AGENTS.md")).toBe(true);
  expect(offenders).toEqual([]);
});
