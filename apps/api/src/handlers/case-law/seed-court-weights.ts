/**
 * Seed court weights for all supported jurisdictions.
 *
 * Run via: bun run apps/api/src/handlers/case-law/seed-court-weights.ts
 *
 * Idempotent: uses ON CONFLICT DO UPDATE so it can be re-run
 * safely after adding new jurisdictions or adjusting weights.
 */

import {
  upsertCourtWeightRows,
  upsertFtsConfigRows,
} from "@/api/lib/case-law/case-law-config-store";

// -- Court weight seed data ----------------------------------------------

type WeightRow = {
  country: string;
  courtPattern: string;
  tier: number;
  tierLabel: string;
  weight: number;
};

const COURT_WEIGHTS: WeightRow[] = [
  // Czech Republic
  {
    country: "CZE",
    courtPattern: "ústavní soud",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "CZE",
    courtPattern: "nejvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "CZE",
    courtPattern: "vrchní soud|krajský soud|městský soud",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },

  // Slovakia
  {
    country: "SVK",
    courtPattern: "ústavný súd",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "SVK",
    courtPattern: "najvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "SVK",
    courtPattern: "krajský súd",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },

  // Poland
  {
    country: "POL",
    courtPattern: "trybunał konstytucyjny",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "POL",
    courtPattern: "sąd najwyższy|naczelny sąd administracyjny",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "POL",
    courtPattern: "sąd apelacyjny|sąd okręgowy",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },

  // Austria
  {
    country: "AUT",
    courtPattern: "verfassungsgerichtshof",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "AUT",
    courtPattern: "oberster gerichtshof|verwaltungsgerichtshof",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "AUT",
    courtPattern: "oberlandesgericht|landesgericht",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },

  // EU
  {
    country: "EU",
    courtPattern: "court of justice",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "EU",
    courtPattern: "general court",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
];

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

  await upsertCourtWeightRows(COURT_WEIGHTS);

  console.log(`  ${COURT_WEIGHTS.length} court weight rows upserted.`);

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
