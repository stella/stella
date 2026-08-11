import { Result } from "better-result";
import type { SQL } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import {
  upsertContactSearchDocument,
  upsertWorkspaceSearchDocument,
} from "@/api/lib/search/index-global";
import {
  SEARCH_PROJECTION_REPAIR_BATCH_SIZE,
  staleContactSearchDocumentsQuery,
  staleEntitySearchDocumentsQuery,
  staleWorkspaceSearchDocumentsQuery,
} from "@/api/lib/search/projection-drift-sql";

const SEARCH_PROJECTION = {
  contact: "contact",
  entity: "entity",
  workspace: "workspace",
} as const;

type SearchProjectionName =
  (typeof SEARCH_PROJECTION)[keyof typeof SEARCH_PROJECTION];

type ProjectionRepairCount = {
  failed: number;
  repaired: number;
};

type ReconcileProjectionOptions<TId extends string> = {
  detect: (limit: number) => SQL;
  projection: SearchProjectionName;
  repair: (id: TId) => Promise<void>;
  signal: AbortSignal | undefined;
};

const reconcileProjection = async <TId extends string>({
  detect,
  projection,
  repair,
  signal,
}: ReconcileProjectionOptions<TId>): Promise<ProjectionRepairCount> => {
  if (signal?.aborted) {
    return { failed: 0, repaired: 0 };
  }

  const drifted = await rootDb.execute<{ id: TId }>(
    detect(SEARCH_PROJECTION_REPAIR_BATCH_SIZE),
  );
  let failed = 0;
  let repaired = 0;

  for (const { id } of drifted) {
    if (signal?.aborted) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: one projection write at a time bounds background DB load
    const outcome = await Result.tryPromise({
      try: async () => await repair(id),
      catch: (error: unknown) => error,
    });
    if (Result.isError(outcome)) {
      failed += 1;
      captureError(outcome.error, { projection, searchProjectionId: id });
      logger.error("search.projection_repair_failed", {
        projection,
        searchProjectionId: id,
      });
      continue;
    }
    repaired += 1;
  }

  return { failed, repaired };
};

export type SearchProjectionReconcileOutcome = ProjectionRepairCount & {
  contacts: number;
  entities: number;
  workspaces: number;
};

type ReconcileSearchProjectionsOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * Converge the entity, contact, and matter search projections onto their
 * sources, repairing whatever a lost post-commit index call left behind.
 *
 * Idempotent: a repaired row stops matching its detection query, and a row
 * the repair could not write is detected again next run, so one failing row
 * costs a single slot of the batch rather than blocking it.
 */
export const reconcileSearchProjections = async ({
  signal,
}: ReconcileSearchProjectionsOptions = {}): Promise<SearchProjectionReconcileOutcome> => {
  // Sequential rather than concurrent: the three scans and their repair
  // writes share one background budget, and the entity pass already touches
  // the matter projection through its activity sync.
  const entities = await reconcileProjection({
    detect: staleEntitySearchDocumentsQuery,
    projection: SEARCH_PROJECTION.entity,
    repair: async (entityId: SafeId<"entity">) =>
      await upsertSearchDocument(entityId),
    signal,
  });
  const contacts = await reconcileProjection({
    detect: staleContactSearchDocumentsQuery,
    projection: SEARCH_PROJECTION.contact,
    repair: async (contactId: SafeId<"contact">) =>
      await upsertContactSearchDocument(contactId),
    signal,
  });
  const workspaces = await reconcileProjection({
    detect: staleWorkspaceSearchDocumentsQuery,
    projection: SEARCH_PROJECTION.workspace,
    repair: async (workspaceId: SafeId<"workspace">) =>
      await upsertWorkspaceSearchDocument(workspaceId),
    signal,
  });

  return {
    contacts: contacts.repaired,
    entities: entities.repaired,
    failed: entities.failed + contacts.failed + workspaces.failed,
    repaired: entities.repaired + contacts.repaired + workspaces.repaired,
    workspaces: workspaces.repaired,
  };
};
