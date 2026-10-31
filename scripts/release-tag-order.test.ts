import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { repoRoot, trackedRepoFiles } from "./oxlint-config-scopes";
import { newestFinalTag } from "./prepare-maintenance-release";

// The app's version line restarted once (v2.9.0 predates v0.9.x), so a
// version-ordered tag list names a long-superseded release as the newest.
// Version order stays correct only among the RC tags of one version.
const versionSort = /--sort=-?(v|version):refname/u;
const rcScoped = /-rc\./u;

test("version-ordered tag listings are scoped to RC tags", () => {
  const offenders: string[] = [];
  for (const file of trackedRepoFiles()) {
    if (
      !(file.startsWith(".github/") || file.startsWith("scripts/")) ||
      file.endsWith(".test.ts")
    ) {
      continue;
    }
    const lines = readFileSync(`${repoRoot}/${file}`, "utf-8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (versionSort.test(line) && !rcScoped.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the previous release is the most recently created final tag", () => {
  // `git tag --sort=-creatordate` order on the real history.
  expect(
    newestFinalTag(["v0.9.69-rc.1", "v0.9.68", "v0.9.67", "v2.9.0", "v2.8.3"]),
  ).toBe("v0.9.68");
  expect(newestFinalTag(["v0.9.69-rc.1"])).toBeUndefined();
});
