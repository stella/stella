import { panic, Result } from "better-result";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import {
  encryptAgentClientCredential,
  readAgentClientCredential,
} from "@/api/agent-auth/credentials";
import type { EncryptedAgentClientCredential } from "@/api/agent-auth/credentials";
import { agentRegistration } from "@/api/db/agent-auth-schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { env } from "@/api/env";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type CredentialDb = Pick<SchedulerDb, "select" | "update">;
type RegistrationCredential = {
  id: string;
  clientId: string;
  clientSecretSink: string;
};

type CompareAndSetOptions = {
  db: CredentialDb;
  registration: RegistrationCredential;
  envelope: EncryptedAgentClientCredential;
};
const compareAndSetCredential = async ({
  db,
  registration,
  envelope,
}: CompareAndSetOptions): Promise<Result<boolean, HandlerError>> =>
  await Result.tryPromise({
    try: async () =>
      (
        await db
          .update(agentRegistration)
          .set({ clientSecretSink: envelope })
          .where(
            and(
              eq(agentRegistration.id, registration.id),
              eq(agentRegistration.clientId, registration.clientId),
              eq(
                agentRegistration.clientSecretSink,
                sql`${registration.clientSecretSink}`,
              ),
            ),
          )
          .returning({ id: agentRegistration.id })
      ).length > 0,
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Could not update agent credentials",
      }),
  });

export const readStoredAgentClientCredential = async (
  db: CredentialDb,
  registration: RegistrationCredential,
): Promise<Result<string, HandlerError>> =>
  await readAgentClientCredential({
    storedCredential: registration.clientSecretSink,
    upgrade: async (envelope) => {
      const updated = await compareAndSetCredential({
        db,
        registration,
        envelope,
      });
      if (Result.isError(updated)) {return Result.err(updated.error);}
      if (updated.value) {return Result.ok(undefined);}
      const loaded = await Result.tryPromise({
        try: async () =>
          (
            await db
              .select({ clientSecretSink: agentRegistration.clientSecretSink })
              .from(agentRegistration)
              .where(
                and(
                  eq(agentRegistration.id, registration.id),
                  eq(agentRegistration.clientId, registration.clientId),
                ),
              )
              .limit(1)
          ).at(0),
        catch: () =>
          new HandlerError({
            status: 503,
            message: "Could not read agent credentials",
          }),
      });
      if (Result.isError(loaded)) {return Result.err(loaded.error);}
      const changed = () =>
        new HandlerError({
          status: 409,
          message: "Agent credential changed during exchange",
        });
      if (!loaded.value) {return Result.err(changed());}
      const current = await readAgentClientCredential({
        storedCredential: loaded.value.clientSecretSink,
        upgrade: async () => Result.err(changed()),
      });
      if (Result.isError(current)) {return Result.err(current.error);}
      return current.value === registration.clientSecretSink
        ? Result.ok(undefined)
        : Result.err(changed());
    },
  });

const previousFormat = sql`${agentRegistration.clientSecretSink} ~ '^[a-f0-9]{64}$'`;
export const AGENT_CLIENT_BATCH_SIZE = 25;
export const AGENT_CLIENT_STATEMENT_BUDGET_MS = 2000;
export const AGENT_CLIENT_LOCK_BUDGET_MS = 500;

type BatchDb = Pick<SchedulerDb, "transaction">;
const withBatchBudget = async <T>(
  db: BatchDb,
  work: (tx: CredentialDb) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, AGENT_CLIENT_STATEMENT_BUDGET_MS);
    await setSharedLockTimeout(tx, AGENT_CLIENT_LOCK_BUDGET_MS);
    return await work(tx);
  });

// This aggregate is an operational completion signal for the finite format transition.
export const countPreviousAgentClientValues = async (
  db: BatchDb,
): Promise<number> =>
  await withBatchBudget(
    db,
    async (tx) =>
      (
        await tx
          .select({ remaining: count() })
          .from(agentRegistration)
          .where(previousFormat)
      ).at(0)?.remaining ?? panic("Agent client count query returned no row"),
  );

type AgentClientBatchOptions = {
  db: BatchDb;
  signal: AbortSignal;
  deadline: number;
};

export const runAgentClientCredentialBatch = async ({
  db,
  signal,
  deadline,
}: AgentClientBatchOptions): Promise<Result<number, HandlerError>> => {
  const run = await Result.tryPromise({
    try: async () =>
      await Result.gen(async function* () {
        if (!env.AGENT_CLIENT_STORAGE_V1_ENABLED) {return Result.ok(0);}
        signal.throwIfAborted();
        if (Temporal.Now.instant().epochMilliseconds >= deadline)
          {return Result.ok(0);}
        const rows = await withBatchBudget(
          db,
          async (tx) =>
            await tx
              .select({
                id: agentRegistration.id,
                clientId: agentRegistration.clientId,
                clientSecretSink: agentRegistration.clientSecretSink,
              })
              .from(agentRegistration)
              .where(previousFormat)
              .orderBy(asc(agentRegistration.id))
              .limit(AGENT_CLIENT_BATCH_SIZE),
        );
        let updatedCount = 0;
        for (const registration of rows) {
          signal.throwIfAborted();
          if (Temporal.Now.instant().epochMilliseconds >= deadline) {break;}
          const envelope = yield* await encryptAgentClientCredential(
            registration.clientSecretSink,
          );
          // Each successful CAS is the durable checkpoint for the next run.
          const updated = yield* await withBatchBudget(
            db,
            async (tx) =>
              await compareAndSetCredential({ db: tx, registration, envelope }),
          );
          if (updated) {updatedCount += 1;}
        }
        return Result.ok(updatedCount);
      }),
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Could not update agent credentials",
      }),
  });
  return Result.isError(run) ? Result.err(run.error) : run.value;
};
