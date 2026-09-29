import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSources,
  legislationWorkNames,
} from "@/api/db/schema";
import { backfillLegislationWorkNamesPage } from "@/api/handlers/legislation/work-name-backfill";
import { toSafeId } from "@/api/lib/branded-types";
import { syncLegislationWorkNamesTx } from "@/api/lib/legal-search/legislation-work-names";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const OLD_TITLE = "7/1990 Sb., o starém názvu";
const NEW_TITLE = "7/1990 Sb., o novém názvu";

/** The id just below `id`, so a one-row page starts exactly at `id`. */
const idBefore = (id: string): string => {
  const last = Number.parseInt(id.slice(-1), 16);
  return `${id.slice(0, -1)}${(last - 1).toString(16)}`;
};

/** A version id whose last digit leaves room for `idBefore`. */
const versionId = (): string => {
  for (;;) {
    const id = Bun.randomUUIDv7();
    if (!id.endsWith("0")) {
      return id;
    }
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("legislation work-name backfill locking (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("legislation work-name backfill locking (postgres)", () => {
    test("an apply waits for a retitle in flight and never restores the old names", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: ingestionDb } = openClient();
        const { db: backfillDb } = openClient();
        const sourceId = toSafeId<"legislationSource">(Bun.randomUUIDv7());
        const documentId = toSafeId<"legislationDocument">(versionId());

        await ingestionDb.insert(legislationSources).values({
          id: sourceId,
          adapterKey: `names-lock-${sourceId}`,
          name: "names lock",
        });
        try {
          await ingestionDb.insert(legislationDocuments).values({
            id: documentId,
            sourceId,
            eli: `eli/test/names-lock/${documentId}`,
            title: OLD_TITLE,
            country: "CZE",
            language: "cs",
            versionValidFrom: "1990-01-01",
          });

          const backfill: ScopedDb = async (fn) =>
            await backfillDb.transaction(async (tx) => await fn(asTestRaw(tx)));

          const held = Promise.withResolvers<undefined>();
          const started = Promise.withResolvers<undefined>();

          // Ingestion's shape: update the version, rewrite its names, commit.
          const retitle = ingestionDb.transaction(async (tx) => {
            await tx
              .update(legislationDocuments)
              .set({ title: NEW_TITLE })
              .where(eq(legislationDocuments.id, documentId));
            await syncLegislationWorkNamesTx(asTestRaw(tx), [
              { id: documentId, country: "CZE", title: NEW_TITLE },
            ]);
            started.resolve(undefined);
            await held.promise;
          });
          await started.promise;

          const page = backfillLegislationWorkNamesPage({
            db: backfill,
            after: toSafeId<"legislationDocument">(idBefore(documentId)),
            pageSize: 1,
            apply: true,
          });
          const settledEarly = await Promise.race([
            page.then(() => true),
            Bun.sleep(500).then(() => false),
          ]);
          expect(settledEarly).toBe(false);

          held.resolve(undefined);
          await retitle;
          expect(await page).toMatchObject({ cursor: documentId, scanned: 1 });

          const official = await ingestionDb
            .select({ officialTitle: legislationWorkNames.officialTitle })
            .from(legislationWorkNames)
            .where(eq(legislationWorkNames.documentId, documentId));
          expect(
            official.flatMap((row) =>
              row.officialTitle === null ? [] : [row.officialTitle],
            ),
          ).toEqual([NEW_TITLE]);
        } finally {
          await ingestionDb
            .delete(legislationDocuments)
            .where(eq(legislationDocuments.id, documentId));
          await ingestionDb
            .delete(legislationSources)
            .where(eq(legislationSources.id, sourceId));
        }
      });
    });
  });
}
