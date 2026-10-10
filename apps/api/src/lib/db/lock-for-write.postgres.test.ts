import { describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { withAggregateLock } from "./aggregate-lock";
import { lockForWrite } from "./lock-for-write";
import {
  canonicalParentLockStatement,
  referenceParentLocks,
} from "./parent-lock-reference.fixture";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("parent batch equivalence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("parent byte order overrides an explicit non-C column collation and matches history", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const db = openClient().db;
      const suffix = mintAuthProviderId<"organization">();
      const ids = ["a", "B", "b", "A"].map((letter) =>
        toSafeId<"organization">(`${letter}_${suffix}`),
      );
      const sorted = ids.toSorted(compareCodeUnit);
      try {
        await db.insert(organization).values(
          ids.map((id) => ({
            id,
            name: "Parent byte order fixture",
            slug: `byte-lock-${id}`,
            createdAt: new Date(),
          })),
        );
        await db.transaction(async (tx) => {
          // The view keeps the locks on public.organization while its ID
          // expression gives the batch a deliberately different collation.
          await tx.execute(sql`CREATE TEMP VIEW organization AS
            SELECT id COLLATE "en-x-icu" AS id FROM public.organization`);
          const localeRows = await tx.execute(sql`SELECT id FROM organization
            WHERE id IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})
            ORDER BY id COLLATE "en-x-icu"`);
          expect(localeRows.map((row) => row["id"])).not.toEqual(sorted);
          const parents = await lockForWrite(tx, { organizationIds: ids });
          expect([...parents.organizationIds]).toEqual(sorted);
          expect(
            await rejectionOf(
              withAggregateLock({
                tx,
                aggregate: "organization",
                id: toSafeId<"organization">(`Z_${suffix}`),
                mode: "key share",
              }),
            ),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
        });
        await db.transaction(async (tx) => {
          for (const id of sorted) {
            expect(
              await withAggregateLock({
                tx,
                aggregate: "organization",
                id,
                mode: "key share",
              }),
            ).toEqual({ status: "locked" });
          }
        });
      } finally {
        await db.delete(organization).where(inArray(organization.id, ids));
      }
    });
  });

  test("parent delegation adds only byte collation to PostgreSQL statements and retains rank history", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const statements: { query: string; params: unknown[] }[] = [];
      const db = openClient({
        logger: {
          logQuery: (query, params) => {
            if (/SELECT id FROM/u.test(query)) {
              statements.push({ query, params });
            }
          },
        },
      }).db;
      const organizationId = mintAuthProviderId<"organization">();
      const otherOrganizationId = mintAuthProviderId<"organization">();
      const workspaceId = createSafeId<"workspace">();
      const otherWorkspaceId = createSafeId<"workspace">();
      const organizationIds = [
        otherOrganizationId,
        organizationId,
        organizationId,
      ];
      const workspaceIds = [otherWorkspaceId, workspaceId, workspaceId];
      try {
        await db.insert(organization).values(
          [organizationId, otherOrganizationId].map((id) => ({
            id,
            name: "Parent lock fixture",
            slug: `parent-lock-${id}`,
            createdAt: new Date(),
          })),
        );
        await db.insert(workspaces).values(
          [workspaceId, otherWorkspaceId].map((id) => ({
            id,
            organizationId,
            name: "Parent lock fixture",
            reference: id,
          })),
        );
        const reference = await db.transaction(
          async (tx) =>
            await referenceParentLocks(tx, { organizationIds, workspaceIds }),
        );
        const referenceStatements = [...statements];
        statements.length = 0;
        const delegated = await db.transaction(async (tx) => {
          const parents = await lockForWrite(tx, {
            organizationIds,
            workspaceIds,
          });
          // A new lower-rank identity must fail before reaching PostgreSQL.
          const missingOrganizationId = mintAuthProviderId<"organization">();
          expect(
            await rejectionOf(
              withAggregateLock({
                tx,
                aggregate: "organization",
                id: missingOrganizationId,
                mode: "key share",
              }),
            ),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          return parents;
        });
        expect(delegated).toEqual(reference);
        expect(statements).toEqual(
          referenceStatements.map((statement) => ({
            ...statement,
            query: canonicalParentLockStatement(statement.query),
          })),
        );
        expect(statements).toHaveLength(2);
        expect(delegated.organizationIds).toEqual(
          new Set([organizationId, otherOrganizationId]),
        );
        expect(delegated.workspaceIds).toEqual(
          new Set([workspaceId, otherWorkspaceId]),
        );
      } finally {
        await db
          .delete(organization)
          .where(
            inArray(organization.id, [organizationId, otherOrganizationId]),
          );
      }
    });
  });
}
