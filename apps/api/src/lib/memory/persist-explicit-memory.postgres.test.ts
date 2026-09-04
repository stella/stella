import { panic } from "better-result";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { organization } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { persistExplicitMemory } from "@/api/lib/memory/persist-explicit-memory";
import type { PersistExplicitMemoryResult } from "@/api/lib/memory/persist-explicit-memory";

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
      const persistenceClient = new SQL({ url: databaseUrl, max: 1 });
      const deletionClient = new SQL({ url: databaseUrl, max: 1 });
      const persistenceDb = drizzle({
        client: persistenceClient,
        relations: databaseRelations,
      });
      const deletionDb = drizzle({
        client: deletionClient,
        relations: databaseRelations,
      });
      const organizationId = toSafeId<"organization">(
        `org_${Bun.randomUUIDv7()}`,
      );
      const dedupKey = new Bun.CryptoHasher("sha256")
        .update(Bun.randomUUIDv7())
        .digest("hex");
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
        createdBy: null,
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
            values,
          });
        });

        const phase = await Promise.race([
          insertCompleted.promise.then(() => "insert_completed" as const),
          Bun.sleep(5000).then(() => "timeout" as const),
        ]);
        expect(phase).toBe("insert_completed");
        if (phase === "timeout") {
          panic("Timed out waiting for the conflicting insert");
        }

        await deletionDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await tx
            .select({ id: aiMemories.id })
            .from(aiMemories)
            .where(eq(aiMemories.id, original.id))
            .for("update");
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
        await persistence?.catch(() => undefined);
        await deletionDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await Promise.all([
          persistenceClient.close({ timeout: 0 }),
          deletionClient.close({ timeout: 0 }),
        ]);
      }
    });
  });
}
