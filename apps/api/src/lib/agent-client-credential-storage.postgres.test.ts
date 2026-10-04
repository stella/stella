import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";

import {
  AGENT_CLIENT_BATCH_SIZE,
  countPreviousAgentClientValues,
  readStoredAgentClientCredential,
  runAgentClientCredentialBatch,
} from "@/api/agent-auth/credential-storage";
import { encryptAgentClientCredential } from "@/api/agent-auth/credentials";
import { agentRegistration } from "@/api/db/agent-auth-schema";
import { schedulerJobs } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  logger,
  resetLogSinkForTesting,
  setLogSinkForTesting,
  type LogRecord,
} from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  BACKFILL_AGENT_CLIENT_STORAGE_TASK,
  backfillAgentClientStorage,
} from "@/api/lib/scheduler/tasks/agent-client-storage-backfill";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

let priorStorageSetting = false;
beforeEach(() => {
  priorStorageSetting = env.AGENT_CLIENT_STORAGE_V1_ENABLED;
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = true;
});
afterEach(() => {
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = priorStorageSetting;
});

type Transaction = Parameters<Parameters<GatedTestDb["transaction"]>[0]>[0];
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const credential = Buffer.alloc(32, 0x2a).toString("hex");

const withStoredValues = async (
  connectionUrl: string,
  work: (db: GatedTestDb) => Promise<void>,
) => {
  await withGatedTestClients(connectionUrl, async ({ openClient }) => {
    const { db } = openClient();
    const schema = `agent_storage_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    try {
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(schema)}.agent_registration (LIKE public.agent_registration INCLUDING ALL)`,
      );
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(schema)}.scheduler_jobs (LIKE public.scheduler_jobs INCLUDING ALL)`,
      );
      const transactionOverride = async <T>(
        fn: (tx: Transaction) => Promise<T>,
      ): Promise<T> =>
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          return await fn(tx);
        });
      const isolated = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return transactionOverride;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      await work(isolated);
    } finally {
      await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    }
  });
};

const seed = async (tx: Transaction, size: number) => {
  const rows = Array.from({ length: size }, () => ({
    id: Bun.randomUUIDv7(),
    registrationType: "service_auth",
    claimTokenHash: Bun.randomUUIDv7(),
    clientId: Bun.randomUUIDv7(),
    clientSecretSink: sql`${credential}`,
    expiresAt: new Date(Date.now() + 60_000),
  }));
  await tx.insert(agentRegistration).values(rows);
  return rows;
};
const batchOptions = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 60_000,
});

if (!databaseUrl || !enabled) {
  describe.skip("agent client storage batches (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("agent client storage batches (postgres)", () => {
    test("a paused task retains rows without accessing storage", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 2));
        const before = await db.transaction(
          async (tx) =>
            await tx
              .select()
              .from(agentRegistration)
              .orderBy(asc(agentRegistration.id)),
        );
        const job = await db.transaction(async (tx) =>
          (
            await tx
              .insert(schedulerJobs)
              .values({
                id: Bun.randomUUIDv7(),
                task: BACKFILL_AGENT_CLIENT_STORAGE_TASK,
                schedule: { type: "interval", everyMs: 60_000 },
                nextRunAt: new Date(),
                payload: { paused: true },
              })
              .returning()
          ).at(0),
        );
        if (!job) {
          throw new Error("scheduler fixture missing");
        }
        const records: LogRecord[] = [];
        setLogSinkForTesting((record) => {
          records.push(record);
        });
        try {
          await backfillAgentClientStorage({
            db,
            job,
            payload: job.payload,
            dueAt: DueSlot.of(job),

            runId: createSafeId<"schedulerJobRun">(),
            scheduleContinuation: () => undefined,
            signal: new AbortController().signal,
            logger,
          });
        } finally {
          resetLogSinkForTesting();
        }
        expect(
          await db.transaction(
            async (tx) =>
              await tx
                .select()
                .from(agentRegistration)
                .orderBy(asc(agentRegistration.id)),
          ),
        ).toEqual(before);
        expect(records).toEqual([]);
        expect(JSON.stringify(records)).not.toContain(credential);
      });
    });

    test("records completion across restarts and accepts an explicit reset", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 2));
        const job = await db.transaction(async (tx) =>
          (
            await tx
              .insert(schedulerJobs)
              .values({
                id: Bun.randomUUIDv7(),
                task: BACKFILL_AGENT_CLIENT_STORAGE_TASK,
                schedule: { type: "interval", everyMs: 60_000 },
                nextRunAt: new Date(),
                payload: {},
              })
              .returning()
          ).at(0),
        );
        if (!job) {
          throw new Error("scheduler fixture missing");
        }
        const context = {
          db,
          job,
          payload: job.payload,
          dueAt: DueSlot.of(job),

          runId: createSafeId<"schedulerJobRun">(),
          scheduleContinuation: () => undefined,
          signal: new AbortController().signal,
          logger,
        };
        await backfillAgentClientStorage(context);
        expect(await countPreviousAgentClientValues(db)).toBe(0);
        const completed = await db.transaction(async (tx) =>
          (
            await tx
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, job.id))
          ).at(0),
        );
        if (!completed) {
          throw new Error("scheduler fixture missing");
        }
        expect(completed.payload?.["completed"]).toBe(true);
        expect(completed.enabled).toBe(false);
        await db.transaction(async (tx) => {
          await seed(tx, 1);
          await tx
            .update(schedulerJobs)
            .set({ enabled: true })
            .where(eq(schedulerJobs.id, job.id));
        });
        const unusedDatabase = new Proxy(db, {
          get() {
            throw new Error("completed task must not access storage");
          },
        });
        await backfillAgentClientStorage({
          ...context,
          db: unusedDatabase,
          job: { ...completed, enabled: true },
          payload: completed.payload,
        });
        expect(await countPreviousAgentClientValues(db)).toBe(1);
        const reset = await db.transaction(async (tx) =>
          (
            await tx
              .update(schedulerJobs)
              .set({ payload: {}, enabled: true })
              .where(eq(schedulerJobs.id, job.id))
              .returning()
          ).at(0),
        );
        if (!reset) {
          throw new Error("scheduler fixture missing");
        }
        await backfillAgentClientStorage({
          ...context,
          job: reset,
          payload: reset.payload,
        });
        expect(await countPreviousAgentClientValues(db)).toBe(0);
      });
    });

    test("retains all rows before the write setting is enabled", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 2));
        const job = await db.transaction(async (tx) =>
          (
            await tx
              .insert(schedulerJobs)
              .values({
                id: Bun.randomUUIDv7(),
                task: BACKFILL_AGENT_CLIENT_STORAGE_TASK,
                schedule: { type: "interval", everyMs: 60_000 },
                nextRunAt: new Date(),
                payload: {},
              })
              .returning()
          ).at(0),
        );
        if (!job) {
          throw new Error("scheduler fixture missing");
        }
        env.AGENT_CLIENT_STORAGE_V1_ENABLED = false;
        const unusedDatabase = new Proxy(db, {
          get() {
            throw new Error("disabled task must not access storage");
          },
        });
        await backfillAgentClientStorage({
          db: unusedDatabase,
          job,
          payload: job.payload,
          dueAt: DueSlot.of(job),

          runId: createSafeId<"schedulerJobRun">(),
          scheduleContinuation: () => undefined,
          signal: new AbortController().signal,
          logger,
        });
        expect(await countPreviousAgentClientValues(db)).toBe(2);
      });
    });

    test("moves all stored values in bounded pages and reaches a fixed point", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        const total = AGENT_CLIENT_BATCH_SIZE * 2 + 3;
        await db.transaction(async (tx) => await seed(tx, total));
        expect(await countPreviousAgentClientValues(db)).toBe(total);
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(AGENT_CLIENT_BATCH_SIZE);
        expect(await countPreviousAgentClientValues(db)).toBe(
          total - AGENT_CLIENT_BATCH_SIZE,
        );
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(AGENT_CLIENT_BATCH_SIZE);
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(3);
        expect(await countPreviousAgentClientValues(db)).toBe(0);
        const before = await db.transaction(
          async (tx) =>
            await tx
              .select()
              .from(agentRegistration)
              .orderBy(asc(agentRegistration.id)),
        );
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(0);
        const after = await db.transaction(
          async (tx) =>
            await tx
              .select()
              .from(agentRegistration)
              .orderBy(asc(agentRegistration.id)),
        );
        expect(after).toEqual(before);
        const values = await db.transaction(
          async (tx) =>
            await Promise.all(
              after.map(async (row) =>
                (await readStoredAgentClientCredential(tx, row)).unwrap(),
              ),
            ),
        );
        expect(values).toEqual(Array.from({ length: total }, () => credential));
        expect(
          after.every((row) =>
            row.clientSecretSink.startsWith("stella-agent:v1:"),
          ),
        ).toBe(true);
      });
    });

    test("accepts an equivalent winner when a read and a batch overlap", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 1));
        const original = await db.transaction(async (tx) =>
          (await tx.select().from(agentRegistration)).at(0),
        );
        if (!original) {
          throw new Error("registration fixture missing");
        }
        let pageLoaded = false;
        const interleaved = {
          transaction: async <T>(
            fn: (tx: Transaction) => Promise<T>,
          ): Promise<T> => {
            const result = await db.transaction(fn);
            if (!pageLoaded) {
              pageLoaded = true;
              expect(
                await db.transaction(async (tx) =>
                  (
                    await readStoredAgentClientCredential(tx, original)
                  ).unwrap(),
                ),
              ).toBe(credential);
            }
            return result;
          },
        };
        expect(
          (
            await runAgentClientCredentialBatch({
              db: interleaved,
              ...batchOptions(),
            })
          ).unwrap(),
        ).toBe(0);
        expect(pageLoaded).toBe(true);
        expect(await countPreviousAgentClientValues(db)).toBe(0);
        expect(
          await db.transaction(async (tx) =>
            (await readStoredAgentClientCredential(tx, original)).unwrap(),
          ),
        ).toBe(credential);
      });
    });

    test("rejects a stale read after a different stored value wins", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 1));
        const original = await db.transaction(async (tx) =>
          (await tx.select().from(agentRegistration)).at(0),
        );
        if (!original) {
          throw new Error("registration fixture missing");
        }
        const replacement = (
          await encryptAgentClientCredential(
            Buffer.alloc(32, 0x2b).toString("hex"),
          )
        ).unwrap();
        await db.transaction(
          async (tx) =>
            await tx
              .update(agentRegistration)
              .set({ clientSecretSink: replacement })
              .where(eq(agentRegistration.id, original.id)),
        );
        const result = await db.transaction(
          async (tx) => await readStoredAgentClientCredential(tx, original),
        );
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error).toBeInstanceOf(HandlerError);
          expect(result.error).toMatchObject({ status: 409 });
        }
        const stored = await db.transaction(async (tx) =>
          (await tx.select().from(agentRegistration)).at(0),
        );
        expect(stored?.clientSecretSink).toBe(replacement);
      });
    });

    test("requires the configured key for a value loaded from storage", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 1));
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(1);
        const stored = await db.transaction(async (tx) =>
          (await tx.select().from(agentRegistration)).at(0),
        );
        if (!stored) {
          throw new Error("registration fixture missing");
        }
        const alternateKey = Buffer.alloc(32, 0x2b).toString("hex");
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "--preload",
            "./src/tests/setup-env.ts",
            "--eval",
            `
            import { Result } from "better-result";
            import { readAgentClientCredential } from "./src/agent-auth/credentials.ts";
            import { HandlerError } from "./src/lib/errors/tagged-errors.ts";
            let updates = 0;
            const result = await readAgentClientCredential({
              storedCredential: process.env.STORED_AGENT_TEST_VALUE,
              upgrade: async () => { updates += 1; return Result.ok(); },
            });
            if (Result.isError(result) && result.error instanceof HandlerError &&
                result.error.message === "Could not read stored agent credential" && updates === 0) {
              process.stdout.write("stored value read refused");
            } else process.exitCode = 1;
          `,
          ],
          cwd: new URL("../../", import.meta.url).pathname,
          env: {
            ...process.env,
            CONTENT_ENCRYPTION_KEY:
              process.env["CONTENT_ENCRYPTION_KEY"] === alternateKey
                ? Buffer.alloc(32, 0x2c).toString("hex")
                : alternateKey,
            STORED_AGENT_TEST_VALUE: stored.clientSecretSink,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, errors).toBe(0);
        expect(output).toBe("stored value read refused");
        expect(errors).not.toContain(credential);
        expect(errors).not.toContain(stored.clientSecretSink);
        const after = await db.transaction(async (tx) =>
          (await tx.select().from(agentRegistration)).at(0),
        );
        expect(after).toEqual(stored);
      });
    });

    test("resumes after a failure while retaining completed row transitions", async () => {
      await withStoredValues(databaseUrl, async (db) => {
        await db.transaction(async (tx) => await seed(tx, 4));
        const interruption = new Error("storage batch interrupted");
        let calls = 0;
        const interrupted = {
          transaction: async <T>(
            fn: (tx: Transaction) => Promise<T>,
          ): Promise<T> => {
            calls += 1;
            if (calls === 4) {
              throw interruption;
            }
            return await db.transaction(fn);
          },
        };
        const result = await runAgentClientCredentialBatch({
          db: interrupted,
          ...batchOptions(),
        });
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error.status).toBe(503);
        }
        expect(await countPreviousAgentClientValues(db)).toBe(2);
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(2);
        expect(await countPreviousAgentClientValues(db)).toBe(0);
        expect(
          (
            await runAgentClientCredentialBatch({ db, ...batchOptions() })
          ).unwrap(),
        ).toBe(0);
      });
    });
  });
}
