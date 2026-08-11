import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { DEV_RUNNER_CONFIG_ENV_NAMES } from "../.oxlint-plugins/forbid-dev-runner-config-reads";

const fixture = readFileSync(
  new URL(
    "../.oxlint-plugins/__fixtures__/forbid-dev-runner-config-reads.fixture.ts",
    import.meta.url,
  ),
  "utf-8",
);

test("exercises every configured dev-runner environment name", () => {
  const exercisedNames = [
    ...fixture.matchAll(/process\.env\["(?<name>STELLA_[A-Z_]+)"\]/gu),
  ].map((match) => match.groups?.["name"]);

  const compareNames = (left: string, right: string) =>
    left.localeCompare(right);
  expect([...new Set(exercisedNames)].sort(compareNames)).toEqual(
    [...DEV_RUNNER_CONFIG_ENV_NAMES].sort(compareNames),
  );
});
