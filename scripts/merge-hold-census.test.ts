import { expect, test } from "bun:test";

import { repoRoot, trackedRepoFiles } from "./oxlint-config-scopes";

const scannedRoots = [".github/", "scripts/", "docs/"];
const fixtureRoot = "scripts/fixtures/merge-group-ejections/";
const retiredNames = [
  ["STELLA", "MERGE", "HOLD"].join("_"),
  ["MERGE", "HOLD"].join("_"),
];

test("tracked automation and documentation contain no retired merge-hold variables", async () => {
  const offenders: string[] = [];
  for (const file of trackedRepoFiles()) {
    if (
      !scannedRoots.some((root) => file.startsWith(root)) ||
      file.startsWith(fixtureRoot)
    ) {
      continue;
    }
    const source = await Bun.file(`${repoRoot}/${file}`).text();
    if (retiredNames.some((name) => source.includes(name))) {
      offenders.push(file);
    }
  }

  expect(offenders).toEqual([]);
});
