/**
 * Backfill persisted preview passages for existing supplemental and chat
 * search projections after the search-preview-passage migration.
 *
 * The operation is idempotent and safe to resume. Run it against each
 * production database after deploying the migration:
 *
 *   bun --filter @stll/api db:backfill-search-previews
 */

import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { backfillChatThreadSearchIndex } from "@/api/lib/search/index-chat";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";

const main = async (): Promise<void> => {
  const organizations = await rootDb.execute<{ id: string }>(sql`
    SELECT id
    FROM organization
    ORDER BY id
  `);

  for (const [index, { id }] of organizations.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- bounded per-tenant rebuild prevents one tenant's derived projection writes from interleaving with another's
    await rebuildSupplementalSearchIndex(toSafeId<"organization">(id));
    console.log(
      `Supplemental search previews rebuilt for organization ${index + 1} of ${organizations.length}.`,
    );
  }

  const indexedThreads = await backfillChatThreadSearchIndex();
  console.log(
    `Search preview backfill complete: ${indexedThreads} chat thread(s) indexed.`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Search preview backfill failed:", error);
    process.exit(1);
  });
