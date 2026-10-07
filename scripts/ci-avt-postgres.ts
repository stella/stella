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
  "apps/api/scripts/avt-postgres-tests.ts",
  "apps/api/scripts/run-postgres-tests.ts",
  "scripts/ci-avt-postgres.test.ts",
];

export const requiresAvtPostgres = (changedPaths: readonly string[]) =>
  changedPaths.some((file) =>
    verificationPaths.some((pattern) => new Bun.Glob(pattern).match(file)),
  );

if (import.meta.main) {
  console.log(String(requiresAvtPostgres(Bun.argv.slice(2))));
}
