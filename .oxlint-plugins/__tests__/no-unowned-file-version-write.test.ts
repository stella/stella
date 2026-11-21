import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects version insertion and aliased current-version patches", async () => {
  expect(
    await lintSingleRule(
      "no-unowned-file-version-write",
      `import {entities,entityVersions as versions} from "@/db/schema";
const patch={currentVersionId:"v"};
tx.insert(versions);
tx.update(entities).set(patch);`,
      { sourcePath: "apps/api/src/handlers/custom.ts" },
    ),
  ).toEqual([3, 4]);
});

test("allows unrelated entity updates", async () => {
  expect(
    await lintSingleRule(
      "no-unowned-file-version-write",
      `import {entities} from "@/db/schema";
tx.update(entities).set({title:"updated"});`,
      { sourcePath: "apps/api/src/handlers/custom.ts" },
    ),
  ).toEqual([]);
});

test("allows the exact reviewed current-version owner", async () => {
  expect(
    await lintSingleRule(
      "no-unowned-file-version-write",
      `import {entities} from "@/db/schema";
tx.update(entities).set({currentVersionId:"v"});`,
      { sourcePath: "apps/api/src/handlers/entities/clip.ts" },
    ),
  ).toEqual([]);
});

test("rejects a same-basename owner in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-unowned-file-version-write",
      `import {entities} from "@/db/schema";
tx.update(entities).set({currentVersionId:"v"});`,
      { sourcePath: "apps/api/src/handlers/other/clip.ts" },
    ),
  ).toEqual([2]);
});
