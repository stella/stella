import { expect, expectTypeOf, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import {
  ONLINE_INDEX_REPLACEMENTS,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
} from "./online-migrations";
import {
  ONLINE_UNIQUE_INDEX_NAMES,
  ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
} from "./online-unique-indexes";

test("every online step identifies its existing migration or code owner", () => {
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
      .filter(({ introducedBy }) =>
        typeof introducedBy === "string"
          ? !folders.has(introducedBy)
          : !existsSync(
              new URL(`../../${introducedBy.owner}`, import.meta.url),
            ),
      )
      .map(({ name, introducedBy }) => ({ name, introducedBy })),
  ).toEqual([]);
});

test("every unique online index has exactly one exported dependency name", () => {
  const registered = ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS.map(
    ({ name }) => name,
  ).toSorted();
  const exported = Object.values(ONLINE_UNIQUE_INDEX_NAMES).toSorted();
  const declared = [
    ...new Set(
      ONLINE_MIGRATION_INDEXES.filter(({ isUnique }) => isUnique).map(
        ({ name }) => name,
      ),
    ),
  ].toSorted();
  expect(registered).toEqual(declared);
  expect(registered).toEqual(exported);
  expect(new Set(registered).size).toBe(registered.length);
});

test("audience-owned repair identifies code provenance", () => {
  expectTypeOf<string>().not.toExtend<
    typeof BETTER_AUTH_OAUTH_RESOURCE_REPAIR.introducedBy
  >();
  expect(BETTER_AUTH_OAUTH_RESOURCE_REPAIR.introducedBy).toEqual({
    type: "code",
    owner: "src/db/better-auth-oauth-resource-repair.ts",
  });
});
