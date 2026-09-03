/**
 * Fill the registered high-volume tables with scale-shaped rows so a
 * migration can be rehearsed against the row counts it meets in production.
 *
 * Run by `scripts/rehearse-migration-upgrade.sh` against a database that
 * holds the previously promoted release's schema and nothing else; the
 * statements are in `seed-migration-rehearsal-plan.ts`. Never for a database
 * that holds real data: the rows are synthetic and the run does not check
 * what is already there.
 *
 *   DATABASE_URL=... bun run src/scripts/seed-migration-rehearsal.ts [--decisions <n>]
 */

import { panic } from "better-result";
import { SQL } from "bun";

import { resolveDatabaseUrl } from "@/api/db-url";
import type { RehearsalSeedStep } from "@/api/scripts/seed-migration-rehearsal-plan";
import {
  REHEARSAL_DEFAULT_DECISIONS,
  rehearsalSeedSteps,
} from "@/api/scripts/seed-migration-rehearsal-plan";

const DECIMAL_INTEGER = /^\d+$/u;
const STATEMENT_TIMEOUT = "10min";

const flagInteger = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const raw = process.argv[index + 1];
  const parsed =
    raw !== undefined && DECIMAL_INTEGER.test(raw)
      ? Number.parseInt(raw, 10)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `--${name} must be a positive integer, got: ${raw ?? "(none)"}`,
    );
    process.exit(1);
  }
  return parsed;
};

/**
 * Apply the steps one after another. Recursive rather than a loop with an
 * awaited body: each step reads what the previous one wrote, so the
 * sequencing is structural.
 */
const applyStepAt = async (
  client: SQL,
  steps: readonly RehearsalSeedStep[],
  offset = 0,
): Promise<void> => {
  const step = steps.at(offset);
  if (step === undefined) {
    return;
  }
  const stepStartedAt = performance.now();
  await client.unsafe(step.statement);
  if (step.table !== null) {
    console.info(
      `${step.table}: ${((performance.now() - stepStartedAt) / 1000).toFixed(1)}s`,
    );
  }
  await applyStepAt(client, steps, offset + 1);
};

const seed = async (): Promise<void> => {
  const url = resolveDatabaseUrl();
  if (!url) {
    panic(
      "seed-migration-rehearsal: no database connection; set DATABASE_URL or the DB_* components",
    );
  }

  const decisions = flagInteger("decisions", REHEARSAL_DEFAULT_DECISIONS);
  // One connection: the plan's numbering table is a temporary table, which
  // lives in the session that created it.
  const client = new SQL({ url, max: 1, connectionTimeout: 30 });
  const startedAt = performance.now();

  try {
    // A bound per statement, well above the largest seed on a CI runner:
    // a statement that runs into it is stuck, not slow.
    await client.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await applyStepAt(client, rehearsalSeedSteps(decisions));
    console.info(
      `seeded ${String(decisions)} decisions and their dependents in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } finally {
    await client.end();
  }
};

await seed();
