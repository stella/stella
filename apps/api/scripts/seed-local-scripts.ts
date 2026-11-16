/**
 * The scripts `seed-local.ts` runs, in order. It spawns them by file name, so
 * CI's dev seed scope (scripts/detect-service-suite-changes.ts) reads this list
 * to follow their imports. No imports: the scope runs before any install.
 */
export const LOCAL_SEED_SCRIPTS = [
  "seed-test-user.ts",
  "seed-dev.ts",
  "seed-legal-lists.ts",
  "seed-legislation.ts",
] as const;
