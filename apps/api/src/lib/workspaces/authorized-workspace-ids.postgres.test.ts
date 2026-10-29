import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  activeAuthorizedWorkspaceQuery,
  authorizedWorkspaceIds,
  authorizedWorkspaceIdSubquery,
  readAuthorizedWorkspaceExecutionAccess,
  readAuthorizedWorkspaces,
} from "@/api/lib/workspaces/authorized-workspace-ids";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)(
  "authorized workspace owner module (postgres)",
  () => {
    test("reads the actor's authorized matters from the view and leaves out a matter outside that set", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const clientId = createSafeId<"contact">();
        const assignedId = createSafeId<"workspace">();
        const closingId = createSafeId<"workspace">();
        const otherId = createSafeId<"workspace">();
        try {
          await db.insert(organization).values({
            id: organizationId,
            name: "Authorized matters fixture",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(user).values({
            id: userId,
            name: "Authorized matters fixture",
            email: `${userId}@example.test`,
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(contacts).values({
            id: clientId,
            organizationId,
            type: "person",
            displayName: "Authorized matters client",
          });
          await db.insert(workspaces).values([
            {
              id: assignedId,
              organizationId,
              clientId,
              name: "Assigned matter",
              reference: "AUTH-ASSIGNED",
            },
            {
              id: closingId,
              organizationId,
              clientId,
              name: "Closing matter",
              reference: "AUTH-CLOSING",
              status: "deleting",
            },
            {
              id: otherId,
              organizationId,
              clientId,
              name: "Other matter",
              reference: "AUTH-OTHER",
            },
          ]);
          await db.insert(workspaceMembers).values([
            { workspaceId: assignedId, userId },
            { workspaceId: closingId, userId },
          ]);

          const scopedDb = createMembershipScopedDb(markRlsDatabase(db), {
            organizationId,
            serverValidatedWorkspaceIds: [],
            userId,
          });
          const outcome = await scopedDb(async (tx) => ({
            set: await readAuthorizedWorkspaces(tx, { organizationId }),
            executionAccess: await readAuthorizedWorkspaceExecutionAccess(tx, {
              organizationId,
            }),
            ids: await authorizedWorkspaceIds(tx, {
              organizationId,
              workspaceIds: [assignedId, closingId, otherId],
            }),
            assigned: await activeAuthorizedWorkspaceQuery(tx, assignedId),
            other: await activeAuthorizedWorkspaceQuery(tx, otherId),
            // Candidates come from a VALUES list, not a row-policy table,
            // so only the subquery decides which survive.
            compared: executedRows(
              await tx.execute(
                sql`SELECT candidate.id::text AS id
                  FROM (VALUES (${assignedId}::uuid), (${otherId}::uuid)) AS candidate(id)
                  WHERE candidate.id IN (${authorizedWorkspaceIdSubquery()})`,
              ),
            ),
          }));

          if (
            outcome.set.isErr() ||
            outcome.ids.isErr() ||
            outcome.executionAccess.isErr()
          ) {
            panic("Authorized workspace read failed");
          }
          expect(outcome.set.value.workspaces).toHaveLength(2);
          expect(outcome.set.value.workspaces).toEqual(
            expect.arrayContaining([
              { id: assignedId, status: "active" },
              { id: closingId, status: "deleting" },
            ]),
          );
          expect(outcome.executionAccess.value.accessibleWorkspaces).toEqual(
            expect.arrayContaining([
              { id: assignedId, status: "active" },
              { id: closingId, status: "deleting" },
            ]),
          );
          expect(
            outcome.executionAccess.value.accessibleWorkspaces,
          ).toHaveLength(2);
          for (const id of [assignedId, closingId]) {
            expect(
              outcome.executionAccess.value.pinServerValidatedWorkspaceId(id),
            ).toBe(true);
          }
          expect(
            outcome.executionAccess.value.pinServerValidatedWorkspaceId(
              otherId,
            ),
          ).toBe(false);
          expect([...outcome.ids.value]).toEqual([assignedId]);
          expect(outcome.assigned).toEqual([{ id: assignedId }]);
          expect(outcome.other).toEqual([]);
          expect(outcome.compared).toEqual([{ id: assignedId }]);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);
