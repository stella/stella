import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const fixture = readFileSync(
  new URL(
    "../.oxlint-plugins/__fixtures__/forbid-dev-runner-config-reads.fixture.ts",
    import.meta.url,
  ),
  "utf-8",
);
const ruleSource = readFileSync(
  new URL(
    "../.oxlint-plugins/forbid-dev-runner-config-reads.ts",
    import.meta.url,
  ),
  "utf-8",
);

test("exercises every configured dev-runner environment name", () => {
  const configuredNamesSource =
    /DEV_RUNNER_CONFIG_ENV_NAMES\s*=\s*\[(?<entries>[\s\S]*?)\]\s*as const/u.exec(
      ruleSource,
    )?.groups?.["entries"] ?? "";
  const configuredNames = [
    ...configuredNamesSource.matchAll(/"(?<name>STELLA_[A-Z_]+)"/gu),
  ]
    .map((match) => match.groups?.["name"])
    .filter((name): name is string => name !== undefined);
  const exercisedNames = [
    ...fixture.matchAll(/process\.env\["(?<name>STELLA_[A-Z_]+)"\]/gu),
  ]
    .map((match) => match.groups?.["name"])
    .filter((name): name is string => name !== undefined);

  const compareNames = (left: string, right: string) =>
    left.localeCompare(right);
  expect([...new Set(exercisedNames)].sort(compareNames)).toEqual(
    [...new Set(configuredNames)].sort(compareNames),
  );
});
