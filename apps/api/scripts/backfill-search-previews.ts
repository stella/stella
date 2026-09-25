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

import { toSafeId } from "@/api/lib/branded-types";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { backfillChatThreadSearchIndex } from "@/api/lib/search/index-chat";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";

const ORGANIZATION_BATCH_SIZE = 100;

const db = openMaintenanceDb({ readOnly: false });

type OrganizationRow = {
  id: string;
};

const main = async (): Promise<void> => {
  let organizationCursor: string | null = null;
  let processedOrganizations = 0;

  for (;;) {
    const organizationRows: Iterable<OrganizationRow> =
      // db-await-in-loop: keyset page per iteration; the page is the batch
      await db.execute<OrganizationRow>(sql`
        SELECT id
        FROM organization
        ${organizationCursor ? sql`WHERE id > ${organizationCursor}` : sql``}
        ORDER BY id
        LIMIT ${ORGANIZATION_BATCH_SIZE}
      `);
    const organizations: OrganizationRow[] = [...organizationRows];
    if (organizations.length === 0) {
      break;
    }

    for (const { id } of organizations) {
      // db-await-in-loop: one organization at a time; each rebuild runs its own scoped pass over that organization's documents
      await rebuildSupplementalSearchIndex(toSafeId<"organization">(id));
      processedOrganizations += 1;
      console.log(
        `Supplemental search previews rebuilt for ${processedOrganizations} organization(s).`,
      );
    }

    const lastOrganization: OrganizationRow | undefined = organizations.at(-1);
    if (
      lastOrganization === undefined ||
      organizations.length < ORGANIZATION_BATCH_SIZE
    ) {
      break;
    }
    organizationCursor = lastOrganization.id;
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
