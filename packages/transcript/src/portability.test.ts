import { expect, test } from "bun:test";

import manifest from "../package.json";

const runtimeFiles = [
  ...new Bun.Glob("**/*.ts").scanSync(import.meta.dir),
].filter((name) => !name.endsWith(".test.ts"));

test("runtime census includes every package entry point", () => {
  expect(runtimeFiles.length).toBeGreaterThan(0);
  for (const entry of Object.values(manifest.exports)) {
    expect(runtimeFiles).toContain(entry.replace("./src/", ""));
  }
});

test.each(runtimeFiles)(
  "%s uses platform-neutral Hermes-compatible operations",
  async (name) => {
    const source = await Bun.file(`${import.meta.dir}/${name}`).text();
    expect(
      source.match(/\.(?:toSorted|toReversed|toSpliced)\(/gu) ?? [],
    ).toEqual([]);
    expect(
      source.match(
        /(?:from\s+|import\s*\()['"](?:node:|bun:|react-native|expo-)/gu,
      ) ?? [],
    ).toEqual([]);
    expect(
      source.match(/\b(?:window|document|process|Buffer)\./gu) ?? [],
    ).toEqual([]);
  },
);
