import { expect, test } from "bun:test";

/**
 * A currency change checks every rate in a table and then restates it, and the
 * default flag is read before a table is cleared or removed. Those decisions
 * hold only while every writer of a rate table or a rate line takes the same
 * matter lock first, so a handler that writes without it fails here.
 */

const WRITES = ["insert", "update", "delete"].flatMap((verb) =>
  ["rateTables", "rateEntries"].map((table) => `.${verb}(${table})`),
);
const LOCK = "await lockMatterRates(tx, workspaceId);";

test("every handler that writes a rate table or a rate line takes the matter rate lock", async () => {
  const paths = await Array.fromAsync(
    new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir }),
  );
  const sources = await Promise.all(
    paths
      .filter((path) => !path.endsWith(".test.ts"))
      .map(async (path) => ({
        path,
        source: await Bun.file(`${import.meta.dir}/${path}`).text(),
      })),
  );
  const writers = sources.filter(({ source }) =>
    WRITES.some((write) => source.includes(write)),
  );

  // The scan found the handlers it is meant to guard.
  expect(writers.map(({ path }) => path).toSorted()).toEqual([
    "create.ts",
    "delete.ts",
    "entries/create.ts",
    "entries/delete.ts",
    "entries/update.ts",
    "update.ts",
  ]);
  expect(
    writers
      .filter(({ source }) => {
        const lockAt = source.indexOf(LOCK);
        const firstWriteAt = Math.min(
          ...WRITES.map((write) => source.indexOf(write)).filter(
            (at) => at !== -1,
          ),
        );
        return lockAt === -1 || lockAt > firstWriteAt;
      })
      .map(({ path }) => path),
  ).toEqual([]);
});
