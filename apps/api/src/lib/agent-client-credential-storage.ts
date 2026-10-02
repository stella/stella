import { panic } from "better-result";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { agentRegistration } from "@/api/db/agent-auth-schema";
import type { rootDb } from "@/api/db/root";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import {
  encryptAgentClientCredential,
  readAgentClientCredential,
} from "@/api/lib/agent-client-credentials";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type CredentialDb = Pick<typeof rootDb, "select" | "update">;
type RegistrationCredential = {
  id: string;
  clientId: string;
  clientSecretSink: string;
};

export const readStoredAgentClientCredential = async (
  db: CredentialDb,
  registration: RegistrationCredential,
): Promise<string> =>
  await readAgentClientCredential({
    storedCredential: registration.clientSecretSink,
    upgrade: async (envelope) => {
      const updated = await db
        .update(agentRegistration)
        .set({ clientSecretSink: envelope })
        .where(
          and(
            eq(agentRegistration.id, registration.id),
            eq(agentRegistration.clientId, registration.clientId),
            eq(
              agentRegistration.clientSecretSink,
              registration.clientSecretSink,
            ),
          ),
        )
        .returning({ id: agentRegistration.id });
      if (updated.length > 0) {
        return;
      }

      const winner = (
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
      ).at(0);
      const changed = () =>
        new HandlerError({
          status: 409,
          message: "Agent credential changed during exchange",
        });
      if (!winner) {
        throw changed();
      }
      const current = await readAgentClientCredential({
        storedCredential: winner.clientSecretSink,
        upgrade: async () => {
          throw changed();
        },
      });
      if (current !== registration.clientSecretSink) {
        throw changed();
      }
    },
  });

const previousFormat = sql`${agentRegistration.clientSecretSink} ~ '^[a-f0-9]{64}$'`;
export const AGENT_CLIENT_BATCH_SIZE = 25;
const STATEMENT_BUDGET_MS = 2000;
const LOCK_BUDGET_MS = 500;

type BatchDb = Pick<typeof rootDb, "transaction">;
const withBatchBudget = async <T>(
  db: BatchDb,
  work: (tx: CredentialDb) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, STATEMENT_BUDGET_MS);
    await setSharedLockTimeout(tx, LOCK_BUDGET_MS);
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
}: AgentClientBatchOptions): Promise<number> => {
  signal.throwIfAborted();
  if (Temporal.Now.instant().epochMilliseconds >= deadline) {
    return 0;
  }
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
  for (const row of rows) {
    signal.throwIfAborted();
    if (Temporal.Now.instant().epochMilliseconds >= deadline) {
      break;
    }
    const envelope = await encryptAgentClientCredential(row.clientSecretSink);
    // Each successful CAS is the durable checkpoint; unchanged rows remain eligible next run.
    // db-await-in-loop: one bounded, independently committed transition per row
    const updated = await withBatchBudget(
      db,
      async (tx) =>
        await tx
          .update(agentRegistration)
          .set({ clientSecretSink: envelope })
          .where(
            and(
              eq(agentRegistration.id, row.id),
              eq(agentRegistration.clientId, row.clientId),
              eq(agentRegistration.clientSecretSink, row.clientSecretSink),
            ),
          )
          .returning({ id: agentRegistration.id }),
    );
    updatedCount += updated.length;
  }
  return updatedCount;
};
