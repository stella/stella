import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import {
  ONLINE_INDEX_REPLACEMENTS,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
} from "./online-migrations";
import { ONLINE_UNIQUE_INDEX_NAMES } from "./online-unique-indexes";

test("every online step identifies an existing migration folder", () => {
  const folders = new Set(
    readdirSync(new URL("../../drizzle/", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name),
  );
  const steps = [
    ...ONLINE_MIGRATION_INDEXES,
    ...ONLINE_MIGRATION_INDEX_CUTOVERS.flatMap((cutover) => [
      { name: cutover.final.name, introducedBy: cutover.introducedBy },
      cutover.final,
      cutover.staged,
    ]),
    ...ONLINE_INDEX_REPLACEMENTS.map(({ legacyName, introducedBy }) => ({
      name: legacyName,
      introducedBy,
    })),
    ...ONLINE_MIGRATION_REPAIRS,
  ];
  expect(steps.length).toBeGreaterThan(0);
  expect(
    steps
      .filter(({ introducedBy }) => !folders.has(introducedBy))
      .map(({ name, introducedBy }) => ({ name, introducedBy })),
  ).toEqual([]);
});

test("every unique online index has exactly one exported dependency name", () => {
  const registered = ONLINE_MIGRATION_INDEXES.filter(({ isUnique }) => isUnique)
    .map(({ name }) => name)
    .toSorted();
  const exported = Object.values(ONLINE_UNIQUE_INDEX_NAMES).toSorted();
  expect(registered).toEqual(exported);
  expect(new Set(registered).size).toBe(registered.length);
});
