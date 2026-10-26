import { expect, test } from "bun:test";

import { partitionTestFiles } from "./test-shard-planning";

test("shared shard planning assigns measured and new files deterministically", () => {
  const files = ["z.test.ts", "a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 4, "b.test.ts": 4 };
  const plan = partitionTestFiles({ files, durations, count: 2 });

  expect(plan).toEqual([["a.test.ts", "z.test.ts"], ["b.test.ts"]]);
  expect(plan.flat().toSorted()).toEqual(files.toSorted());
  expect(
    partitionTestFiles({ files: files.toReversed(), durations, count: 2 }),
  ).toEqual(plan);
});
