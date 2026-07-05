import { and, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb, Transaction } from "@/api/db";
import { documentTypes, fields } from "@/api/db/schema";
import {
  materializePlaybookRun,
  resolveDocTypeClassifier,
} from "@/api/handlers/playbooks/materialize-run";
import type {
  PlaybookPositions,
  PlaybookScope,
  PlaybookTrigger,
} from "@/api/handlers/playbooks/positions";
import { captureError } from "@/api/lib/analytics";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

// One shared routing seam. `resolveApplicablePlaybooks` narrows a set of org
// playbooks to those that apply to a workspace's documents (workspace-wide, or
// doc-type-scoped when that type is present among the "Document Type" classifier
// values). Both the manual files-table auto-run and the classification trigger
// resolve through here so the applicability rules cannot drift between surfaces.

export type RoutablePlaybook = {
  id: SafeId<"playbookDefinition">;
  positions: PlaybookPositions;
  scope: PlaybookScope | null;
};

// The scope column is nullable and `trigger` is optional, so a stored playbook
// may carry no trigger at all. Reads must default to `manual` regardless of how
// Elysia coerced the field at write time.
export const playbookTrigger = (scope: PlaybookScope | null): PlaybookTrigger =>
  scope?.trigger ?? "manual";

// Only `onClassified` playbooks participate in classification-driven routing;
// `manual` playbooks run solely on an explicit run/auto-run.
export const selectRoutablePlaybooks = <
  T extends { scope: PlaybookScope | null },
>(
  playbooks: readonly T[],
): T[] =>
  playbooks.filter(
    (playbook) => playbookTrigger(playbook.scope) === "onClassified",
  );

// Pure applicability filter shared by the DB path and its tests. A playbook with
// no `documentTypeKey` is workspace-wide (always applies); a doc-type-scoped one
// survives only when its resolved label is present among the classifier values.
export const filterPlaybooksByPresentLabels = <
  T extends { scope: PlaybookScope | null },
>({
  playbooks,
  labelByKey,
  presentLabels,
}: {
  playbooks: readonly T[];
  labelByKey: ReadonlyMap<string, string>;
  presentLabels: ReadonlySet<string>;
}): T[] =>
  playbooks.filter((playbook) => {
    const key = playbook.scope?.documentTypeKey;
    if (!key) {
      return true;
    }
    const label = labelByKey.get(key);
    return label !== undefined && presentLabels.has(label);
  });

// Recursion guard for classification-driven routing. A playbook run materializes
// ASK/verdict columns whose completion must NOT re-trigger routing; only a
// workflow that actually (re)computed the Document Type classifier should route.
// Those materialized columns are never the classifier, so its id is absent from
// their plan and this returns false, closing the loop.
export const classifierParticipatedInPlan = ({
  classifierPropertyId,
  planPropertyIds,
}: {
  classifierPropertyId: SafeId<"property">;
  planPropertyIds: readonly SafeId<"property">[];
}): boolean => planPropertyIds.includes(classifierPropertyId);

// Narrow the org's playbooks to those applicable to this workspace's documents.
// Workspace-wide playbooks pass through; doc-type-scoped ones survive only when
// their label is present among the classifier's values. One distinct query over
// the candidate labels keeps the read bounded by the document-type count.
export const resolveApplicablePlaybooks = async ({
  tx,
  workspaceId,
  organizationId,
  playbooks,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  playbooks: readonly RoutablePlaybook[];
}): Promise<RoutablePlaybook[]> => {
  const scoped = playbooks.filter((playbook) =>
    Boolean(playbook.scope?.documentTypeKey),
  );
  // No doc-type-scoped playbooks: every candidate is workspace-wide, so skip the
  // classifier resolution entirely.
  if (scoped.length === 0) {
    return [...playbooks];
  }

  const scopedKeys = [
    ...new Set(
      scoped
        .map((playbook) => playbook.scope?.documentTypeKey)
        .filter((key): key is string => typeof key === "string"),
    ),
  ];

  const classifier = await resolveDocTypeClassifier(tx, workspaceId);
  // No "Document Type" classifier means doc-type gating cannot be resolved, so
  // only workspace-wide playbooks apply.
  if (!classifier) {
    return playbooks.filter((playbook) => !playbook.scope?.documentTypeKey);
  }

  const docTypeRows = await tx
    .select({ key: documentTypes.key, label: documentTypes.label })
    .from(documentTypes)
    .where(
      and(
        eq(documentTypes.organizationId, organizationId),
        inArray(documentTypes.key, scopedKeys),
      ),
    )
    .limit(LIMITS.documentTypesCount);
  const labelByKey = new Map(docTypeRows.map((row) => [row.key, row.label]));

  const presentLabels = new Set<string>();
  const candidateLabels = [...new Set(labelByKey.values())];
  if (candidateLabels.length > 0) {
    const presentRows = await tx
      .selectDistinct({
        value: sql<string>`${fields.content}->>'value'`,
      })
      .from(fields)
      .where(
        and(
          eq(fields.workspaceId, workspaceId),
          eq(fields.propertyId, classifier.id),
          inArray(sql`${fields.content}->>'value'`, candidateLabels),
        ),
      )
      .limit(LIMITS.documentTypesCount);
    for (const row of presentRows) {
      if (row.value) {
        presentLabels.add(row.value);
      }
    }
  }

  return filterPlaybooksByPresentLabels({
    playbooks,
    labelByKey,
    presentLabels,
  });
};

// Audit marker distinguishing an auto-routed run from a user-initiated one. The
// EXECUTE/PLAYBOOK row is otherwise identical to a manual run (see
// materializePlaybookRun); this metadata plus the absent request context (no IP
// / user-agent, since the background recorder has no HTTP request) mark it as
// system-triggered.
const ROUTED_AUDIT_METADATA = {
  source: "system",
  trigger: "onClassified",
} as const;

// Injected rather than imported to avoid a static import cycle with
// workflow-queue (which imports this module). Structurally matches
// `startWorkflow`.
type StartWorkflowFn = (args: {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  propertyIds: SafeId<"property">[];
}) => Promise<{ status: string }>;

type RouteClassifiedDocumentsArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  startWorkflow: StartWorkflowFn;
};

// Classification-driven routing: after the Document Type classifier resolves for
// a workspace, materialize every applicable `onClassified` org playbook over the
// files table and start one workflow across the union of materialized columns.
// Idempotent by construction: materializePlaybookRun upserts by playbookSourceId,
// so re-running over an already-materialized playbook maps back to the same
// columns instead of duplicating them; already-graded verdict cells are only
// re-queued (set stale) when their definition changed, matching a manual re-run.
// A per-playbook failure (e.g. the properties cap) skips that one; the batch and
// the classification workflow that called this never fail because of it.
export const routeClassifiedDocuments = async ({
  workspaceId,
  organizationId,
  userId,
  scopedDb,
  startWorkflow,
}: RouteClassifiedDocumentsArgs): Promise<void> => {
  const materializedPropertyIds = await scopedDb(async (tx) => {
    const playbooks = await tx.query.playbookDefinitions.findMany({
      where: { organizationId: { eq: organizationId } },
      columns: { id: true, positions: true, scope: true },
      limit: LIMITS.playbookDefinitionsCount,
    });

    const routable = selectRoutablePlaybooks(playbooks);
    if (routable.length === 0) {
      return [] as SafeId<"property">[];
    }

    const applicable = await resolveApplicablePlaybooks({
      tx,
      workspaceId,
      organizationId,
      playbooks: routable,
    });
    if (applicable.length === 0) {
      return [] as SafeId<"property">[];
    }

    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
    });

    const ids: SafeId<"property">[] = [];
    for (const playbook of applicable) {
      // oxlint-disable-next-line no-await-in-loop -- one shared transaction: each run reads the cumulative property count to enforce the per-workspace cap, and a single tx cannot run writes in parallel
      const result = await materializePlaybookRun({
        tx,
        workspaceId,
        organizationId,
        playbookId: playbook.id,
        positions: playbook.positions.items,
        scope: playbook.scope,
        recordAuditEvent,
        auditMetadata: ROUTED_AUDIT_METADATA,
      });
      if (!result.ok || result.materializedPropertyIds.length === 0) {
        continue;
      }
      ids.push(...result.materializedPropertyIds);
    }
    return ids;
  });

  if (materializedPropertyIds.length === 0) {
    return;
  }

  const started = await startWorkflow({
    workspaceId,
    organizationId,
    userId,
    scopedDb,
    propertyIds: materializedPropertyIds,
  });
  // A concurrent run may already hold the workspace lock; the materialized ASK
  // columns are stale ai-model columns, so the in-flight run's straggler
  // catch-up (or the next run) still grades them. Record the skip for context.
  if (started.status !== "started") {
    captureError(new Error("routeClassifiedDocuments.workflow_not_started"), {
      workspaceId,
      status: started.status,
    });
  }
};
