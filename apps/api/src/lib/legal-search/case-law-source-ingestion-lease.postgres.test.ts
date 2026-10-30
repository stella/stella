import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { caseLawSources } from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;

describe.skipIf(!enabled)("case-law source ingestion lease owner", () => {
  test("releases once for every completed work outcome and refuses held work", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const scopedDb = createIngestionDb(markRlsDatabase(db));
      const sourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
        name: "Lease owner PostgreSQL fixture",
      });

      const assertReleased = async () => {
        const source = (
          await db
            .select({
              expiresAt: caseLawSources.ingestionLeaseExpiresAt,
              token: caseLawSources.ingestionLeaseToken,
            })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0);
        expect(source).toEqual({ expiresAt: null, token: null });
      };
      const run = async <T>(
        work: Parameters<typeof withCaseLawSourceIngestionLease<T>>[1],
      ) => {
        let releases = 0;
        const releaseDb = createIngestionDb(markRlsDatabase(db));
        const value = await withCaseLawSourceIngestionLease(
          {
            scopedDb,
            sourceId,
            releaseDb: async (query) => {
              releases++;
              return await releaseDb(query);
            },
          },
          work,
        );
        expect(releases).toBe(1);
        await assertReleased();
        return value;
      };

      expect(await run(async () => "completed")).toBe("completed");

      const failed = Result.err(new Error("expected failed result"));
      expect(await run(async () => failed)).toBe(failed);

      const rejection = await rejectionOf(
        run(async () => {
          throw new Error("expected work rejection");
        }),
      );
      expect(rejection).toBeInstanceOf(Error);
      if (!(rejection instanceof Error)) {
        panic("Expected work rejection to be an Error");
      }
      expect(rejection.message).toBe("expected work rejection");

      let heldWorkRan = false;
      const held = await withCaseLawSourceIngestionLease(
        { scopedDb, sourceId },
        async () => {
          const refused = await withCaseLawSourceIngestionLease(
            { scopedDb, sourceId },
            async () => {
              heldWorkRan = true;
            },
          );
          expect(refused).toBeNull();
          return "holder completed";
        },
      );
      expect(held).toBe("holder completed");
      expect(heldWorkRan).toBe(false);
      await assertReleased();

      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });
  });
});
