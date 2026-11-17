import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { auditLogs, savedSearches } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { safeDbIn } from "@/api/tests/helpers/lock-then-write-race";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { savedSearchReadScalingScenario } from "@/api/tests/read-scaling/saved-searches";

import getSavedSearch from "./get";
import updateSavedSearch from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgres || !databaseUrl) {
  describe.skip("saved-search concurrent editors", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("saved-search concurrent editors", () => {
    test("concurrent editors preserve the winner and reload stays a bounded point read", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const actorA = openClient({ max: 1 }).db;
        const actorB = openClient({ max: 1 }).db;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const savedSearchId = createSafeId<"savedSearch">();
        const token = "2099-01-01T00:00:00.000Z";
        const answers: unknown[] = [];
        try {
          await db.insert(user).values({
            id: userId,
            name: "Saved-search editor",
            email: `${userId}@example.test`,
            emailVerified: true,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Saved-search editing",
            slug: organizationId,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          });
          const audit = createAuditRecorder({
            organizationId,
            workspaceId: null,
            userId,
            request: new Request("https://example.test/v1/saved-searches"),
            server: null,
          });
          const transaction =
            (actor: GatedTestDb) =>
            async <T>(run: (tx: Transaction) => Promise<T>) =>
              (
                await createSafeDb(
                  markRlsDatabase(actor),
                  [],
                  organizationId,
                  userId,
                )(run, { retry: { times: 0, delayMs: 0, backoff: "constant" } })
              ).unwrap();
          const write = (name: string) => async (tx: Transaction) => {
            answers.push(
              await updateSavedSearch.handler(
                createTestHandlerContext<
                  Parameters<typeof updateSavedSearch.handler>[0]
                >({
                  session: { activeOrganizationId: organizationId },
                  user: { id: userId },
                  params: { savedSearchId },
                  body: { name, expectedUpdatedAt: token },
                  safeDb: safeDbIn(tx),
                  scopedDb: NO_DB,
                  audit,
                }),
              ),
            );
          };
          await withInterleaving({
            databaseUrl,
            a: {
              transaction: transaction(actorA),
              steps: [{ name: "update", run: write("First writer") }],
            },
            b: {
              transaction: transaction(actorB),
              steps: [{ name: "update", run: write("Waiting writer") }],
            },
            schedules: [["a.update", "b.update", "a.commit", "b.commit"]],
            reset: async () => {
              await db.insert(savedSearches).values({
                id: savedSearchId,
                organizationId,
                userId,
                name: "Original",
                updatedAt: new Date(token),
                criteria: {
                  version: 1,
                  query: "motion",
                  workspaceIds: [],
                  types: [],
                  kinds: [],
                  editedByUserIds: [],
                  mimeTypes: [],
                  sort: "relevance",
                },
              });
            },
            readState: async () => ({
              rows: await db
                .select()
                .from(savedSearches)
                .where(eq(savedSearches.id, savedSearchId)),
              audits: await db
                .select()
                .from(auditLogs)
                .where(eq(auditLogs.resourceId, savedSearchId)),
            }),
            invariant: ({ blocked, outcomes, state }) => {
              expect(blocked).toContain("b.update");
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              expect(answers).toMatchObject([
                {
                  id: savedSearchId,
                  name: "First writer",
                  updatedAt: "2099-01-01T00:00:00.001Z",
                },
                {
                  code: 409,
                  response: { code: API_VERSION_CONFLICT_ERROR_CODE },
                },
              ]);
              expect(answers).toHaveLength(2);
              expect(state.rows).toMatchObject([{ name: "First writer" }]);
              expect(state.audits).toHaveLength(1);
            },
          });
          const readContext = createTestHandlerContext<
            Parameters<typeof getSavedSearch.handler>[0]
          >({
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            params: { savedSearchId },
            safeDb: createSafeDb(
              markRlsDatabase(actorA),
              [],
              organizationId,
              userId,
            ),
            scopedDb: NO_DB,
            audit,
          });
          expect(savedSearchReadScalingScenario.definition).toBe(
            getSavedSearch,
          );
          const small =
            await savedSearchReadScalingScenario.measure(readContext);
          const target =
            (
              await db
                .select()
                .from(savedSearches)
                .where(eq(savedSearches.id, savedSearchId))
            ).at(0) ?? panic("Expected the saved-search scaling target");
          await db.insert(savedSearches).values(
            Array.from({ length: 200 }, () => ({
              id: createSafeId<"savedSearch">(),
              organizationId,
              userId,
              name: "Other saved search",
              criteria: target.criteria,
              createdAt: target.createdAt,
              updatedAt: target.updatedAt,
            })),
          );
          const large =
            await savedSearchReadScalingScenario.measure(readContext);
          expect(small.statements).toBeGreaterThan(0);
          expect(small.transactionRoundTrips).toBeGreaterThan(0);
          expect(large).toEqual(small);
          expect(large.id).toBe(savedSearchId);
          expect(large.rows).toBe(1);
          expect(readScalingViolations({ small, large })).toEqual([]);
        } finally {
          await deleteOrganizationsForTest(db, [organizationId]);
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  });
}
