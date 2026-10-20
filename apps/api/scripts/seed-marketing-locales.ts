/**
 * Seed the per-locale marketing firms the localized product screenshots
 * film (apps/web/e2e/marketing/product-screenshots.spec.ts): for every
 * non-English locale, its owner, its organization and a full dev seed in
 * that language (seed-content/<locale>.ts). Every visible name, document and
 * fixture AI answer comes from the content pack; nothing calls a model.
 *
 * Run after `db:seed-dev` has seeded the English firm: the shared case-law
 * corpus comes from that run.
 *
 * Usage:
 *   bun run db:seed-marketing-locales
 */

import {
  MARKETING_LOCALE_ACCOUNTS,
  MARKETING_LOCALES,
  marketingSeedNamespace,
  PRIMARY_MARKETING_LOCALE,
} from "@stll/playwright-tools/marketing-locales";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { requireLocalDevOpen } from "@/api/runtime-mode";

// Refuse before importing the database-owning seed module.
requireLocalDevOpen("Seeding the marketing locale firms");

const {
  enrolInTimeBilling,
  ensureMembershipExists,
  ensureOrganizationExists,
  ensureUserExists,
} = await import("./seed-test-user");

for (const locale of MARKETING_LOCALES) {
  // db:seed-dev seeds the primary firm before this runs.
  if (locale === PRIMARY_MARKETING_LOCALE) {
    continue;
  }
  const account = MARKETING_LOCALE_ACCOUNTS[locale];
  const startedAt = performance.now();
  const userId = await ensureUserExists({
    id: account.userId,
    name: account.userName,
    email: account.email,
  });
  await ensureOrganizationExists(account.organizationId);
  await ensureMembershipExists({
    organizationId: account.organizationId,
    userId,
    role: "owner",
  });
  await enrolInTimeBilling({ organizationId: account.organizationId, userId });

  // The dev seed derives its tables from these at import, so each firm is
  // its own process.
  const child = Bun.spawn({
    cmd: [process.execPath, `${import.meta.dir}/seed-dev.ts`],
    env: {
      ...process.env,
      STELLA_SEED_ID_NAMESPACE: marketingSeedNamespace(locale),
      STELLA_SEED_ORG_ID: account.organizationId,
      STELLA_SEED_USER_ID: userId,
    },
    stderr: "inherit",
    stdout: "inherit",
  });
  await child.exited;
  const exitCode = childExitStatus(child);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  const seconds = (performance.now() - startedAt) / 1000;
  console.log(`  ${locale} firm seeded in ${seconds.toFixed(1)} s`);
}
process.exit(0);
