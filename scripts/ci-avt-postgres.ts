import path from "node:path";

import packageJson from "../apps/api/package.json" with { type: "json" };

// Job admission and suite selection share this set: every database test inside
// an admitted API path participates in the verification PR slice.
const verificationPaths = [
  "apps/api/src/lib/lists/verification/**",
  "apps/api/src/handlers/lists/verifications/**",
  "apps/api/src/handlers/lists/verification-routes*",
  "apps/api/src/handlers/lists/routes.ts",
  "apps/api/src/lib/api-handlers-list-verification*",
  "apps/api/drizzle/*verification*/**",
  "apps/api/src/handlers/lists/items/sources/verification/**",
  "apps/api/src/db/list-verification*",
  "apps/api/src/db/schema/lists-verification.ts",
  "apps/api/src/lib/views/avt-layout*",
  "apps/api/src/lib/scheduler/tasks/list-verification*",
  "apps/web/src/features/avt/**",
  "apps/web/src/routes/**/lists/source-verification-action*",
  ".github/workflows/ci.yml",
  "scripts/ci-avt-postgres.ts",
  "scripts/ci-avt-postgres.test.ts",
];

export const requiresAvtPostgres = (changedPaths: readonly string[]) =>
  changedPaths.some((file) =>
    verificationPaths.some((pattern) => new Bun.Glob(pattern).match(file)),
  );

export const avtPostgresTestFiles = async (
  apiRoot = path.resolve(import.meta.dir, "../apps/api"),
) => {
  const { discoverGatedTestFiles } =
    await import("../apps/api/scripts/run-gated-tests");
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
    .toSorted();
};

if (import.meta.main) {
  console.log(String(requiresAvtPostgres(Bun.argv.slice(2))));
}
