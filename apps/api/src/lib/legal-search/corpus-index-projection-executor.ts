import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { buildCorpusProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  planCorpusProjectionAppendRequests,
  type CorpusProjectionAppendEntry,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  readReservedCorpusProjectionMaterialsTx,
  type CorpusProjectionMaterial,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
import {
  abandonCorpusProjectionAppendTx,
  cancelCorpusProjectionReservationTx,
  commitCorpusProjectionAppendTx,
  prepareCorpusProjectionReplacementsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendTx,
  type CorpusProjectionIntentLease,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  readCorpusAst,
  readCorpusAtAuthoritativePointer,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;
type ProjectionAppendClient = Pick<CorpusIndexClient, "ingestCommittedBatch">;

type ExecuteCorpusProjectionAppendCycleOptions = {
  runInTransaction: ProjectionTransactionRunner;
  client: ProjectionAppendClient;
  family: CorpusProjectionIntentLease["family"];
  generation: string;
  limit: number;
  leaseMs: number;
};

export type CorpusProjectionAppendCycleResult = {
  status: "idle" | "completed" | "append_unknown";
  replacementCleanupScheduled: number;
  reserved: number;
  applied: number;
  staleCleanupPending: number;
  unknownCleanupPending: number;
  cancelled: number;
  leaseLost: number;
  unread: number;
  requestCount: number;
};

const emptyResult = (
  replacementCleanupScheduled: number,
): CorpusProjectionAppendCycleResult => ({
  status: "idle",
  replacementCleanupScheduled,
  reserved: 0,
  applied: 0,
  staleCleanupPending: 0,
  unknownCleanupPending: 0,
  cancelled: 0,
  leaseLost: 0,
  unread: 0,
  requestCount: 0,
});

const cancelReservations = async ({
  runInTransaction,
  leases,
  errorMessage,
}: {
  runInTransaction: ProjectionTransactionRunner;
  leases: readonly CorpusProjectionIntentLease[];
  errorMessage: string;
}): Promise<{ cancelled: number; leaseLost: number }> => {
  if (leases.length === 0) {
    return { cancelled: 0, leaseLost: 0 };
  }
  return await runInTransaction(async (tx) => {
    let cancelled = 0;
    let leaseLost = 0;
    for (const lease of leases) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction serializes exact lease transitions
      const outcome = await cancelCorpusProjectionReservationTx(tx, {
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        errorMessage,
      });
      if (outcome === "cancelled") {
        cancelled += 1;
      } else {
        leaseLost += 1;
      }
    }
    return { cancelled, leaseLost };
  });
};

const rereadMaterial = async (
  runInTransaction: ProjectionTransactionRunner,
  lease: CorpusProjectionIntentLease,
): Promise<CorpusProjectionMaterial | null> => {
  const current = await runInTransaction(
    async (tx) =>
      await readReservedCorpusProjectionMaterialsTx(tx, { leases: [lease] }),
  );
  return current.ready.at(0) ?? null;
};

const loadCorpusProjectionPayload = async (
  runInTransaction: ProjectionTransactionRunner,
  material: CorpusProjectionMaterial,
) => {
  let currentPromise: Promise<CorpusProjectionMaterial | null> | undefined;
  const current = async () => {
    currentPromise ??= rereadMaterial(runInTransaction, material.lease);
    return await currentPromise;
  };
  const textPromise = readCorpusAtAuthoritativePointer({
    storedKey: material.textS3Key,
    read: readCorpusText,
    rereadStoredKey: async () => (await current())?.textS3Key ?? null,
  });
  if (material.family === "legislation" || material.astS3Key === null) {
    return { text: await textPromise, ast: null };
  }
  const astPromise = readCorpusAtAuthoritativePointer({
    storedKey: material.astS3Key,
    read: readCorpusAst,
    rereadStoredKey: async () => {
      const replacement = await current();
      return replacement?.family === "case_law" ? replacement.astS3Key : null;
    },
  });
  const [text, ast] = await Promise.all([textPromise, astPromise]);
  return { text, ast };
};

type PreparedProjectionEntry = {
  material: CorpusProjectionMaterial;
  entry: CorpusProjectionAppendEntry;
};

type PreparedProjectionRequest = {
  indexId: string;
  entries: readonly PreparedProjectionEntry[];
};

const buildPreparedEntry = async (
  runInTransaction: ProjectionTransactionRunner,
  material: CorpusProjectionMaterial,
): Promise<Result<PreparedProjectionEntry, unknown>> => {
  const payload = await Result.tryPromise(
    async () => await loadCorpusProjectionPayload(runInTransaction, material),
  );
  if (payload.isErr()) {
    return Result.err(payload.error);
  }
  const documents = (() => {
    switch (material.family) {
      case "case_law":
        return buildCorpusProjectionDocuments({
          manifest: material.manifest,
          input: material.input,
          payload: payload.value,
          revision: material.lease.intentId,
        });
      case "legislation":
        return buildCorpusProjectionDocuments({
          manifest: material.manifest,
          input: material.input,
          payload: payload.value,
          revision: material.lease.intentId,
        });
      default:
        return material satisfies never;
    }
  })();
  return Result.ok({
    material,
    entry: { revision: material.lease.intentId, documents },
  });
};

const planPreparedRequests = (
  entries: readonly PreparedProjectionEntry[],
): PreparedProjectionRequest[] => {
  const byIndex = new Map<string, PreparedProjectionEntry[]>();
  for (const prepared of entries) {
    const group = byIndex.get(prepared.material.lease.indexId);
    if (group === undefined) {
      byIndex.set(prepared.material.lease.indexId, [prepared]);
    } else {
      group.push(prepared);
    }
  }
  const requests: PreparedProjectionRequest[] = [];
  for (const indexId of [...byIndex.keys()].sort()) {
    const group = byIndex.get(indexId) ?? panic(`Lost projection index group`);
    const planned = planCorpusProjectionAppendRequests(
      group.map(({ entry }) => entry),
    );
    if (planned.isErr()) {
      return panic(planned.error.message);
    }
    const byRevision = new Map(
      group.map((prepared) => [prepared.entry.revision, prepared]),
    );
    for (const request of planned.value) {
      requests.push({
        indexId,
        entries: request.entries.map(
          ({ revision }) =>
            byRevision.get(revision) ??
            panic(`Lost planned projection revision ${revision}`),
        ),
      });
    }
  }
  return requests;
};

const addCancellation = (
  result: CorpusProjectionAppendCycleResult,
  cancellation: { cancelled: number; leaseLost: number },
): void => {
  result.cancelled += cancellation.cancelled;
  result.leaseLost += cancellation.leaseLost;
};

/**
 * Execute one bounded append cycle. Plane chooses scope, cadence, limits, and
 * concurrency; this primitive owns durable ordering and exact outcomes.
 */
export const executeCorpusProjectionAppendCycle = async ({
  runInTransaction,
  client,
  family,
  generation,
  limit,
  leaseMs,
}: ExecuteCorpusProjectionAppendCycleOptions): Promise<CorpusProjectionAppendCycleResult> => {
  const { replacements, leases } = await runInTransaction(async (tx) => ({
    replacements: await prepareCorpusProjectionReplacementsTx(tx, {
      family,
      generation,
      limit,
    }),
    leases: await reserveCorpusProjectionIntentsTx(tx, {
      family,
      generation,
      limit,
      leaseMs,
    }),
  }));
  if (leases.length === 0) {
    return emptyResult(replacements.length);
  }
  const result: CorpusProjectionAppendCycleResult = {
    ...emptyResult(replacements.length),
    status: "completed",
    reserved: leases.length,
  };
  const materials = await runInTransaction(
    async (tx) => await readReservedCorpusProjectionMaterialsTx(tx, { leases }),
  );
  const rejectedLeases = materials.rejected
    .filter(({ status }) => status !== "lease_lost")
    .map(({ lease }) => lease);
  result.leaseLost += materials.rejected.length - rejectedLeases.length;
  result.unread += materials.rejected.filter(
    ({ status }) => status === "unreadable",
  ).length;
  addCancellation(
    result,
    await cancelReservations({
      runInTransaction,
      leases: rejectedLeases,
      errorMessage: "projection material is no longer readable or current",
    }),
  );

  const loaded = await Promise.all(
    materials.ready.map(
      async (material) =>
        ({
          material,
          loaded: await buildPreparedEntry(runInTransaction, material),
        }) as const,
    ),
  );
  const unreadLeases = loaded
    .filter(({ loaded: entry }) => entry.isErr())
    .map(({ material }) => material.lease);
  result.unread += unreadLeases.length;
  addCancellation(
    result,
    await cancelReservations({
      runInTransaction,
      leases: unreadLeases,
      errorMessage: "projection payload read failed before append",
    }),
  );
  const prepared = loaded.flatMap(({ loaded: entry }) =>
    entry.isOk() ? [entry.value] : [],
  );
  const requests = planPreparedRequests(prepared);

  for (const [requestIndex, request] of requests.entries()) {
    // Start only this physical request. A crash leaves every later request in
    // `reserved`, so recovery never mistakes unattempted work for an append.
    // oxlint-disable-next-line no-await-in-loop -- request outcomes are durably serialized by design
    const starts = await runInTransaction(async (tx) => {
      const outcomes: {
        prepared: PreparedProjectionEntry;
        status: "started" | "stale_cancelled" | "lease_lost";
      }[] = [];
      for (const preparedEntry of request.entries) {
        // oxlint-disable-next-line no-await-in-loop -- exact state locks share one short transaction
        const status = await startCorpusProjectionAppendTx(tx, {
          intentId: preparedEntry.material.lease.intentId,
          leaseToken: preparedEntry.material.lease.leaseToken,
        });
        outcomes.push({ prepared: preparedEntry, status });
      }
      return outcomes;
    });
    result.cancelled += starts.filter(
      ({ status }) => status === "stale_cancelled",
    ).length;
    result.leaseLost += starts.filter(
      ({ status }) => status === "lease_lost",
    ).length;
    const started = starts
      .filter(({ status }) => status === "started")
      .map(({ prepared: preparedEntry }) => preparedEntry);
    if (started.length === 0) {
      continue;
    }
    const startedPlan = planCorpusProjectionAppendRequests(
      started.map(({ entry }) => entry),
    );
    if (startedPlan.isErr() || startedPlan.value.length !== 1) {
      return panic("Started projection request no longer fits its plan");
    }
    result.requestCount += 1;
    // External I/O occurs after the start transaction has released every lock.
    // oxlint-disable-next-line no-await-in-loop -- stop after the first unknown physical request outcome
    const appended = await client.ingestCommittedBatch(
      request.indexId,
      startedPlan.value.at(0)?.ndjson ??
        panic("Projection request plan is empty"),
    );
    if (appended.isErr()) {
      // oxlint-disable-next-line no-await-in-loop -- persist the exact unknown set before returning
      const abandoned = await runInTransaction(async (tx) => {
        let cleanupPending = 0;
        let leaseLost = 0;
        for (const preparedEntry of started) {
          // oxlint-disable-next-line no-await-in-loop -- exact unknown outcomes share one short transaction
          const outcome = await abandonCorpusProjectionAppendTx(tx, {
            intentId: preparedEntry.material.lease.intentId,
            leaseToken: preparedEntry.material.lease.leaseToken,
            errorMessage: appended.error.message,
          });
          if (outcome === "cleanup_pending") {
            cleanupPending += 1;
          } else {
            leaseLost += 1;
          }
        }
        return { cleanupPending, leaseLost };
      });
      result.unknownCleanupPending += abandoned.cleanupPending;
      result.leaseLost += abandoned.leaseLost;
      const laterLeases = requests
        .slice(requestIndex + 1)
        .flatMap(({ entries: laterEntries }) =>
          laterEntries.map(({ material }) => material.lease),
        );
      addCancellation(
        result,
        // oxlint-disable-next-line no-await-in-loop -- stop path cancels every provably unattempted reservation
        await cancelReservations({
          runInTransaction,
          leases: laterLeases,
          errorMessage: "projection append stopped after an unknown request",
        }),
      );
      result.status = "append_unknown";
      return result;
    }

    // oxlint-disable-next-line no-await-in-loop -- finalize the exact committed request before starting another
    const committed = await runInTransaction(async (tx) => {
      let applied = 0;
      let staleCleanupPending = 0;
      let leaseLost = 0;
      for (const preparedEntry of started) {
        // oxlint-disable-next-line no-await-in-loop -- desired-state CAS transitions share one short transaction
        const outcome = await commitCorpusProjectionAppendTx(tx, {
          intentId: preparedEntry.material.lease.intentId,
          leaseToken: preparedEntry.material.lease.leaseToken,
        });
        switch (outcome.status) {
          case "applied":
            applied += 1;
            break;
          case "stale_cleanup_pending":
            staleCleanupPending += 1;
            break;
          case "lease_lost":
            leaseLost += 1;
            break;
          default:
            outcome satisfies never;
        }
      }
      return { applied, staleCleanupPending, leaseLost };
    });
    result.applied += committed.applied;
    result.staleCleanupPending += committed.staleCleanupPending;
    result.leaseLost += committed.leaseLost;
  }
  return result;
};
