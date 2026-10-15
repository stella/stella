import { expect, test } from "bun:test";

import { createFormattedArtifactCache } from "./formatted-artifact-cache";

const formatterSpy = () => {
  const batches: string[][] = [];
  const format = createFormattedArtifactCache(async (artifacts) => {
    batches.push([...artifacts.keys()]);
    return new Map(
      [...artifacts].map(([fileName, raw]) => [fileName, raw.toUpperCase()]),
    );
  });
  return { batches, format };
};

test("identical artifacts reuse their formatted output", async () => {
  const { batches, format } = formatterSpy();
  const artifacts = new Map([
    ["a.ts", "const a = 1;"],
    ["b.ts", "const b = 2;"],
  ]);
  const first = await format(artifacts, "config");
  const second = await format(artifacts, "config");
  expect(second).toEqual(first);
  expect([...second]).toEqual([
    ["a.ts", "CONST A = 1;"],
    ["b.ts", "CONST B = 2;"],
  ]);
  expect(batches).toEqual([["a.ts", "b.ts"]]);
});

test("only new or changed artifacts reach the formatter", async () => {
  const { batches, format } = formatterSpy();
  await format(
    new Map([
      ["a.ts", "const a = 1;"],
      ["b.ts", "const b = 2;"],
    ]),
    "config",
  );
  const result = await format(
    new Map([
      ["a.ts", "const a = 1;"],
      ["b.ts", "const b = 3;"],
      ["c.ts", "const c = 4;"],
    ]),
    "config",
  );
  expect([...result]).toEqual([
    ["a.ts", "CONST A = 1;"],
    ["b.ts", "CONST B = 3;"],
    ["c.ts", "CONST C = 4;"],
  ]);
  expect(batches).toEqual([
    ["a.ts", "b.ts"],
    ["b.ts", "c.ts"],
  ]);
});

test("a changed configuration or dropped artifact misses the cache", async () => {
  const { batches, format } = formatterSpy();
  const artifacts = new Map([["a.ts", "const a = 1;"]]);
  await format(artifacts, "config");
  await format(artifacts, "other config");
  await format(new Map([["b.ts", "const b = 2;"]]), "other config");
  await format(artifacts, "other config");
  expect(batches).toEqual([["a.ts"], ["a.ts"], ["b.ts"], ["a.ts"]]);
});
