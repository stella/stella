import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { createMemoryDedupIdentity } from "@/api/lib/memory/memory-dedup";
import {
  persistExplicitMemory,
  resolveMemoryWriteScope,
} from "@/api/lib/memory/persist-explicit-memory";
import type { PersistExplicitMemoryResult } from "@/api/lib/memory/persist-explicit-memory";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type PauseAfterFirstInsertOptions = {
  insertCompleted: PromiseWithResolvers<undefined>;
  resume: Promise<undefined>;
  tx: Transaction;
};

const pauseAfterFirstInsert = ({
  insertCompleted,
  resume,
  tx,
}: PauseAfterFirstInsertOptions): Transaction => {
  let paused = false;

  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== "insert") {
        return Reflect.get(target, property, receiver);
      }

      return (table: typeof aiMemories) => {
        const builder = target.insert(table);

        return new Proxy(builder, {
          get(builderTarget, builderProperty, builderReceiver) {
            if (builderProperty !== "values") {
              return Reflect.get(
                builderTarget,
                builderProperty,
                builderReceiver,
              );
            }

            return (values: typeof aiMemories.$inferInsert) => {
              const query = builderTarget.values(values);
              const execute = query.execute.bind(query);
              query.execute = async () => {
                const rows = await execute();
                if (!paused) {
                  paused = true;
                  insertCompleted.resolve(undefined);
                  await resume;
                }
                return rows;
              };
              return query;
            };
          },
        });
      };
    },
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("explicit memory dedup deletion race (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("explicit memory dedup deletion race (postgres)", () => {
    test("a conflicting row deleted before it can be locked is recreated", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const persistenceDb = openClient().db;
        const deletionDb = openClient().db;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const content = "Keep the procedural history concise";
        const identity = createMemoryDedupIdentity({
          scope: "organization",
          userId: null,
          workspaceId: null,
          kind: "preference",
          content,
          sourceDataWorkspaceIds: [],
        });
        const dedupKey = identity.dedupKey;
        const values = {
          organizationId,
          scope: "organization",
          userId: null,
          workspaceId: null,
          kind: "preference",
          content: "Keep the procedural history concise",
          dedupKey,
          language: "en",
          sourceDataWorkspaceIds: [],
          source: "user",
          status: "active",
          pinned: false,
          createdBy: userId,
        } satisfies typeof aiMemories.$inferInsert;
        const auditEvents: AuditEvent[] = [];
        const recordAuditEvent: AuditRecorder = async (_tx, event) => {
          auditEvents.push(...(Array.isArray(event) ? event : [event]));
        };
        const insertCompleted = Promise.withResolvers<undefined>();
        const resumePersistence = Promise.withResolvers<undefined>();
        let persistence: Promise<PersistExplicitMemoryResult> | undefined;

        try {
          await deletionDb.insert(organization).values({
            id: organizationId,
            createdAt: new Date(),
            name: "Memory dedup race organization",
            slug: `memory-dedup-race-${organizationId}`,
          });
          await deletionDb
            .insert(user)
            .values({
              id: userId,
              name: "Memory settings",
              email: `${userId}@example.test`,
            });
          const scope = resolveMemoryWriteScope({
            accessibleWorkspaces: [],
            authority: sessionMemberRole("owner"),
            organizationId,
            userId,
            request: { scope: "organization", kind: "preference" },
          }).unwrap();
          const [original] = await deletionDb
            .insert(aiMemories)
            .values(values)
            .returning({ id: aiMemories.id });
          if (!original) {
            panic("Expected the conflicting memory row");
          }

          persistence = persistenceDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            return await persistExplicitMemory({
              tx: pauseAfterFirstInsert({
                tx,
                insertCompleted,
                resume: resumePersistence.promise,
              }),
              recordAuditEvent,
              scope,
              memory: {
                content,
                language: "en",
                sourceDataWorkspaceIds: [],
                source: "user",
                pinned: false,
              },
            });
          });

          const phase = await Promise.race([
            insertCompleted.promise.then(() => "insert_completed" as const),
            persistence.then(() => "finished" as const),
          ]);
          expect(phase).toBe("insert_completed");
          if (phase !== "insert_completed") {
            panic("Timed out waiting for the conflicting insert");
          }

          await deletionDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            await tx.delete(aiMemories).where(eq(aiMemories.id, original.id));
          });
          expect(
            await deletionDb.$count(
              aiMemories,
              and(
                eq(aiMemories.organizationId, organizationId),
                eq(aiMemories.dedupKey, dedupKey),
              ),
            ),
          ).toBe(0);

          resumePersistence.resolve(undefined);
          const result = await persistence;
          const stored = await deletionDb
            .select({ id: aiMemories.id, content: aiMemories.content })
            .from(aiMemories)
            .where(
              and(
                eq(aiMemories.organizationId, organizationId),
                eq(aiMemories.dedupKey, dedupKey),
              ),
            );

          expect(result.type).toBe("created");
          expect(result.id).not.toBe(original.id);
          expect(stored).toEqual([
            { id: result.id, content: "Keep the procedural history concise" },
          ]);
          expect(auditEvents).toEqual([
            expect.objectContaining({
              action: AUDIT_ACTION.CREATE,
              resourceId: result.id,
            }),
          ]);
        } finally {
          resumePersistence.resolve(undefined);
          if (persistence) {
            await Promise.allSettled([persistence]);
          }
          await deletionDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await deletionDb.delete(user).where(eq(user.id, userId));
        }
      });
    });
  });
}
