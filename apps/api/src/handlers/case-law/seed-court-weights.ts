/**
 * Seed court weights for all supported jurisdictions.
 *
 * Run via: bun run apps/api/src/handlers/case-law/seed-court-weights.ts
 *
 * Idempotent: uses ON CONFLICT DO UPDATE so it can be re-run
 * safely after adding new jurisdictions or adjusting weights.
 */

import { COURT_WEIGHT_SEED } from "@/api/handlers/case-law/court-weight-seed";
import {
  upsertCourtWeightRows,
  upsertFtsConfigRows,
} from "@/api/lib/case-law/case-law-config-store";

// -- FTS config seed data ------------------------------------------------

type FtsRow = {
  language: string;
  regconfig: string;
  useUnaccent: boolean;
};

const FTS_CONFIGS: FtsRow[] = [
  { language: "cs", regconfig: "simple", useUnaccent: true },
  { language: "sk", regconfig: "simple", useUnaccent: true },
  { language: "pl", regconfig: "simple", useUnaccent: true },
  { language: "de", regconfig: "german", useUnaccent: true },
  { language: "en", regconfig: "english", useUnaccent: false },
  { language: "fr", regconfig: "french", useUnaccent: true },
  { language: "es", regconfig: "spanish", useUnaccent: false },
  { language: "it", regconfig: "italian", useUnaccent: false },
  { language: "hu", regconfig: "simple", useUnaccent: true },
  { language: "lt", regconfig: "simple", useUnaccent: true },
  { language: "lv", regconfig: "simple", useUnaccent: true },
  { language: "et", regconfig: "simple", useUnaccent: false },
];

// -- Seed ----------------------------------------------------------------

/* oxlint-disable no-console -- CLI seed script */
const seed = async () => {
  console.log("Seeding court weights...");

  await upsertCourtWeightRows([...COURT_WEIGHT_SEED]);

  console.log(`  ${COURT_WEIGHT_SEED.length} court weight rows upserted.`);

  console.log("Seeding FTS configs...");

  await upsertFtsConfigRows(FTS_CONFIGS);

  console.log(`  ${FTS_CONFIGS.length} FTS config rows upserted.`);

  console.log("Done.");
  process.exit(0);
};

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Seed failed:", message);
  process.exit(1);
});
/* oxlint-enable no-console */
