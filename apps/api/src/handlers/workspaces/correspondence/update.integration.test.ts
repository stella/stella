import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, correspondence } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateCorrespondence from "./update";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.execute(
    sql`ALTER TABLE correspondence FORCE ROW LEVEL SECURITY`,
  );
});
afterAll(releaseRlsFixture);

describe("correspondence handling audit", () => {
  test("records exactly the changed fields and omits no-op audit events", async () => {
    try {
      await testDb.transaction(async (tx) => {
        const cases = [
          {
            body: { assigneeId: ids.userA2 },
            changes: { assigneeId: { old: null, new: ids.userA2 } },
          },
          {
            body: { handlingState: "handled" },
            changes: { handlingState: { old: "new", new: "handled" } },
          },
          {
            body: { handlingState: "handled", assigneeId: ids.userA2 },
            changes: {
              handlingState: { old: "new", new: "handled" },
              assigneeId: { old: null, new: ids.userA2 },
            },
          },
          {
            body: { handlingState: "new", assigneeId: ids.userA2 },
            changes: { assigneeId: { old: null, new: ids.userA2 } },
          },
          {
            body: { handlingState: "handled", assigneeId: null },
            changes: { handlingState: { old: "new", new: "handled" } },
          },
          { body: { handlingState: "new", assigneeId: null }, changes: null },
          { body: {}, changes: null },
        ] as const;
        for (const { body, changes } of cases) {
          const id = createSafeId<"correspondence">();
          await tx.insert(correspondence).values({
            id,
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            channel: "email",
            direction: "in",
            intake: "direct",
            authenticatedSenderAddress: "sender@example.test",
            originalSignature: null,
            contentHash: "a".repeat(64),
            dedupKey: id.replaceAll("-", "").repeat(2),
            from: { address: "sender@example.test", name: null },
            to: [],
            cc: [],
            subject: "Handling audit",
            receivedAt: new Date("2026-09-27T12:00:00.000Z"),
            references: [],
            bodyText: "Handling audit",
            spf: "pass",
            dkim: "pass",
            dmarc: "pass",
            handlingState: "new",
            assigneeId: null,
          });
          const result = await updateCorrespondence.handler(
            asTestRaw<Parameters<typeof updateCorrespondence.handler>[0]>({
              body,
              params: { correspondenceId: id },
              workspaceId: ids.wsA2,
              memberRole: { role: "owner" },
              user: { id: ids.userA1 },
              request: new Request("https://api.example.test/correspondence"),
              session: { activeOrganizationId: ids.orgA },
              safeDb: asTestRaw<SafeDb>(
                createSafeDb(
                  markRlsDatabase(tx),
                  [ids.wsA2],
                  ids.orgA,
                  ids.userA1,
                ),
              ),
              recordAuditEvent: createAuditRecorder({
                organizationId: ids.orgA,
                workspaceId: ids.wsA2,
                userId: ids.userA1,
                request: new Request("https://api.example.test/correspondence"),
                server: null,
              }),
            }),
          );
          expect(result).toMatchObject({ record: { id } });
          await tx.execute(sql`RESET ROLE`);
          expect(
            await tx
              .select({ changes: auditLogs.changes })
              .from(auditLogs)
              .where(eq(auditLogs.resourceId, id)),
          ).toEqual(changes === null ? [] : [{ changes }]);
        }
        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
    throw new Error("Expected integration transaction rollback");
  });
});
