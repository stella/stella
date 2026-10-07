import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { requiresAvtPostgres } from "../../../scripts/ci-avt-postgres";
import packageJson from "../package.json" with { type: "json" };
import { discoverGatedTestFiles } from "./run-gated-tests";

export const avtPostgresTestFiles = async (
  apiRoot = path.resolve(import.meta.dir, ".."),
) => {
  const runner = packageJson.ciGateTestRunners["test:postgres"];
  const discovered = await discoverGatedTestFiles({
    apiRoot,
    gate: runner.gate,
    testFileGlob: runner.testFileGlob,
  });
  const databaseTests = [
    ...new Bun.Glob("src/**/*.db.test.ts").scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
  ];
  return [...new Set([...discovered, ...databaseTests])]
    .filter((file) => requiresAvtPostgres([`apps/api/${file}`]))
    .toSorted(compareCodeUnit);
};
