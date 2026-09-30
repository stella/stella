import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditions,
  sanctionsSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { commitSanctionsMonitoringBatch } from "./monitoring-diff";
import type { SanctionsMonitoringResult } from "./monitoring-diff";
import { monitoringFingerprint } from "./monitoring-input";
import { disableSanctionsMonitoring } from "./monitoring-opt-out";
import type { SanctionsPossibleMatch } from "./screening-service";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("concurrent sanctions firm opt-out", () => {
    test("requires the migrated PostgreSQL test profile", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  test("a first firm opt-out racing a monitoring commit leaves exclusions and retained lapsed hits", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const admin = openClient().db;
      const commitDb = openClient().db;
      const optOutDb = openClient().db;
      const organizationId = mintAuthProviderId<"organization">();
      const editionId = createSafeId<"sanctionsEdition">();
      const now = new Date();
      const editionHash = createHash("sha256").update(editionId).digest("hex");
      const existingSource = (
        await admin
          .select()
          .from(sanctionsSources)
          .where(eq(sanctionsSources.id, "eu"))
          .limit(1)
      ).at(0);
      await admin.insert(organization).values({
        id: organizationId,
        name: "Synthetic monitoring organization",
        slug: organizationId,
        createdAt: now,
      });
      try {
        await admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx
            .insert(sanctionsSources)
            .values({
              id: "eu",
              issuer: "EU",
              markerUrl: "https://example.test/list",
            })
            .onConflictDoNothing();
          await tx.insert(sanctionsEditions).values({
            id: editionId,
            sourceId: "eu",
            markerKey: editionHash,
            contentHash: editionHash,
            publishedAt: "2026-09-29",
            state: "ready",
            entryCount: 0,
          });
        });
        const contact =
          (
            await admin
              .insert(contacts)
              .values({
                organizationId,
                type: "person",
                displayName: "Synthetic Person",
              })
              .returning()
          ).at(0) ?? panic("Contact missing");
        const fingerprint = monitoringFingerprint(contact);
        const match = {
          sourceEntryId: "synthetic",
          editionId,
          score: 1,
          sourceUrl: "https://example.test/list",
          name: "Synthetic Person",
          referenceNumber: null,
          entityType: "person",
          programme: null,
          listedOn: null,
          evidence: {
            nameScore: 1,
            matchedName: "Synthetic Person",
            birthDate: "not-compared",
            nationality: "not-compared",
            entityType: "match",
            identifier: "not-compared",
            conflicts: [],
          },
        } satisfies SanctionsPossibleMatch;
        await admin.insert(sanctionsContactMatches).values({
          organizationId,
          contactId: contact.id,
          sourceId: "eu",
          sourceEntryId: match.sourceEntryId,
          editionId,
          state: "active",
          contactFingerprint: fingerprint,
          entryHash: editionHash,
          match,
          updatedAt: now,
        });
        await admin.insert(sanctionsContactScreenings).values({
          organizationId,
          contactId: contact.id,
          sourceId: "eu",
          editionId,
          status: "possible-match",
          contactFingerprint: fingerprint,
          checkedAt: now,
        });
        expect(
          await admin.query.organizationSettings.findFirst({
            where: { organizationId: { eq: organizationId } },
          }),
        ).toBeUndefined();
        const scopedDb: ScopedDb = async (run) =>
          await commitDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            return await run(tx);
          });
        const prepared = {
          contactId: contact.id,
          contactFingerprint: fingerprint,
          outcome: {
            source: "eu",
            issuer: "EU",
            classification: "informational",
            status: "unavailable",
            reason: "load-failed",
            editionId: null,
            publishedAt: null,
            verifiedAt: null,
            pendingUpdate: null,
            totalMatches: 0,
            truncated: false,
            possibleMatches: [],
          },
        } satisfies SanctionsMonitoringResult;
        await Promise.all([
          commitSanctionsMonitoringBatch({
            db: scopedDb,
            organizationId,
            source: "eu",
            results: [prepared],
            now,
          }),
          optOutDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            expect(
              (
                await tx.execute<{ role: string }>(
                  sql`SELECT current_user AS role`,
                )
              ).at(0)?.role,
            ).toBe("stella");
            return await disableSanctionsMonitoring(tx, {
              organizationId,
              now,
              recordAuditEvent: async () => undefined,
            });
          }),
        ]);
        expect(
          (
            await admin
              .select()
              .from(sanctionsContactScreenings)
              .where(
                and(
                  eq(sanctionsContactScreenings.organizationId, organizationId),
                  eq(sanctionsContactScreenings.contactId, contact.id),
                ),
              )
          ).every((row) => row.status === "excluded"),
        ).toBe(true);
        const retained = await admin
          .select()
          .from(sanctionsContactMatches)
          .where(
            and(
              eq(sanctionsContactMatches.organizationId, organizationId),
              eq(sanctionsContactMatches.contactId, contact.id),
            ),
          );
        expect(retained).toHaveLength(1);
        expect(retained.at(0)?.state).toBe("lapsed");
        expect(
          (
            await admin
              .select()
              .from(organizationSettings)
              .where(eq(organizationSettings.organizationId, organizationId))
          ).at(0)?.sanctionsMonitoringMode,
        ).toBe("disabled");
      } finally {
        await admin
          .delete(organization)
          .where(eq(organization.id, organizationId));
        // Fixture cleanup uses the owner; ingestion deliberately has no DELETE grant.
        await admin.transaction(async (tx) => {
          await tx
            .delete(sanctionsEditions)
            .where(eq(sanctionsEditions.id, editionId));
          if (existingSource === undefined) {
            await tx
              .delete(sanctionsSources)
              .where(eq(sanctionsSources.id, "eu"));
          }
        });
      }
    });
  }, 60_000);
}
