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

/** A formatter whose batches finish only when the test releases them. */
const deferredFormatter = () => {
  const batches: string[][] = [];
  const releases: (() => void)[] = [];
  const format = createFormattedArtifactCache(async (artifacts) => {
    batches.push([...artifacts.keys()]);
    const output = new Map(
      [...artifacts].map(([fileName, raw]) => [fileName, raw.toUpperCase()]),
    );
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    return output;
  });
  const release = (index: number) => {
    const resolve = releases[index];
    if (resolve === undefined) {
      throw new TypeError(`No formatter batch ${index}`);
    }
    resolve();
  };
  return { batches, format, release };
};

test("an overlapping call cannot change the outputs another call reuses", async () => {
  const { batches, format, release } = deferredFormatter();
  const seeded = format(new Map([["a.ts", "const a = 1;"]]), "config");
  release(0);
  await seeded;

  // Reuses a.ts and waits on b.ts while a second call changes, then drops, a.ts.
  const reusing = format(
    new Map([
      ["a.ts", "const a = 1;"],
      ["b.ts", "const b = 2;"],
    ]),
    "config",
  );
  const changing = format(new Map([["a.ts", "const a = 9;"]]), "config");
  release(2);
  expect([...(await changing)]).toEqual([["a.ts", "CONST A = 9;"]]);
  const dropping = format(new Map([["c.ts", "const c = 3;"]]), "config");
  release(3);
  await dropping;
  release(1);
  expect([...(await reusing)]).toEqual([
    ["a.ts", "CONST A = 1;"],
    ["b.ts", "CONST B = 2;"],
  ]);
  expect(batches).toEqual([["a.ts"], ["b.ts"], ["a.ts"], ["c.ts"]]);
});

test("a call that outlives a configuration change does not publish its entries", async () => {
  const { batches, format, release } = deferredFormatter();
  const artifacts = new Map([["a.ts", "const a = 1;"]]);
  const stale = format(new Map([["a.ts", "const a = 0;"]]), "config");
  const current = format(artifacts, "other config");
  release(1);
  await current;
  release(0);
  await stale;
  // The cache still holds the latest configuration's entry, so this reuses it.
  expect([...(await format(artifacts, "other config"))]).toEqual([
    ["a.ts", "CONST A = 1;"],
  ]);
  expect(batches).toEqual([["a.ts"], ["a.ts"]]);
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
