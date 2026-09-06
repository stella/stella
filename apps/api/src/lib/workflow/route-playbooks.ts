import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { documentTypes, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { loadLatestApprovedVersions } from "@/api/lib/document-review/approved-playbook-versions";
import { openPlaybookRun } from "@/api/lib/document-review/open-playbook-run";
import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { LIMITS } from "@/api/lib/limits";
import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";
import type { DocTypeClassifier } from "@/api/lib/workflow/materialize-playbook-run";
import { resolveDocTypeClassifier } from "@/api/lib/workflow/materialize-playbook-run";
import type {
  PlaybookPositions,
  PlaybookScope,
  PlaybookTrigger,
} from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";

// One shared routing seam. `resolveApplicablePlaybooks` narrows a set of org
// playbooks to those that apply to a workspace's documents (workspace-wide, or
// doc-type-scoped when that type is present among the "Document Type" classifier
// values). Both the manual files-table auto-run and the classification trigger
// resolve through here so the applicability rules cannot drift between surfaces.

// Everything routing needs to decide a playbook applies, plus what pinning it
// needs when it has never been approved (`name`/`positions` are the draft
// snapshot `resolvePlaybookPin` falls back to).
export type RoutablePlaybook = {
  id: SafeId<"playbookDefinition">;
  name: string;
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
export const resolveApplicablePlaybooks = async <T extends RoutablePlaybook>({
  tx,
  workspaceId,
  organizationId,
  playbooks,
  classifier: preResolvedClassifier,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  // Generic over the row: applicability reads only `scope`, and a caller that
  // selected more columns (the pinned name, say) keeps them on the way out.
  playbooks: readonly T[];
  // The "Document Type" classifier, pre-resolved by a caller that already
  // fetched it (classification routing threads it in to avoid a duplicate
  // lookup). Omitted by the auto-run path, which resolves it internally below.
  classifier?: DocTypeClassifier | null;
}): Promise<T[]> => {
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

  const classifier =
    preResolvedClassifier === undefined
      ? await resolveDocTypeClassifier(tx, workspaceId)
      : preResolvedClassifier;
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
// `startWorkflow`; the status union is imported as a type (erased, so no
// cycle) rather than restated, since a hand-written copy could not tell this
// path that a new status exists.
type StartWorkflowFn = (args: {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  propertyIds: SafeId<"property">[];
}) => Promise<{ status: WorkflowStartStatus }>;

type RouteClassifiedDocumentsArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  startWorkflow: StartWorkflowFn;
  // The classifier the calling workflow already resolved (see
  // maybeRouteClassifiedDocuments): threaded into resolveApplicablePlaybooks so
  // the "Document Type" column is not looked up a second time per routed run.
  classifier: DocTypeClassifier;
};

// Classification-driven routing: after the Document Type classifier resolves for
// a workspace, run every applicable `onClassified` org playbook over the files
// table — projected onto it, pinned to the same approved snapshot a manual run
// pins, opening the same durable per-document runs — and start one workflow
// across the union of materialized columns.
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
  classifier,
}: RouteClassifiedDocumentsArgs): Promise<void> => {
  const materializedPropertyIds = await scopedDb(async (tx) => {
    // Push the trigger predicate into the query for this path: only
    // `onClassified` playbooks route, so filtering in SQL avoids fetching the
    // `positions` JSONB for manual playbooks that would be discarded anyway.
    // (`scope->>'trigger'` is NULL for a null scope or an absent trigger, so a
    // manual/legacy playbook is excluded — matching `playbookTrigger`'s default.)
    const routable = await tx.query.playbookDefinitions.findMany({
      where: {
        organizationId: { eq: organizationId },
        RAW: (table) => sql`${table.scope}->>'trigger' = 'onClassified'`,
      },
      columns: { id: true, name: true, positions: true, scope: true },
      limit: LIMITS.playbookDefinitionsCount,
    });

    // Defense in depth: the SQL predicate already excludes non-`onClassified`
    // playbooks; re-checking the returned rows keeps the invariant enforced in
    // app code too, and is cheap over the already-narrowed set.
    const onClassified = selectRoutablePlaybooks(routable);
    if (onClassified.length === 0) {
      const emptyPropertyIds: SafeId<"property">[] = [];
      return emptyPropertyIds;
    }

    const applicable = await resolveApplicablePlaybooks({
      tx,
      workspaceId,
      organizationId,
      playbooks: onClassified,
      classifier,
    });
    if (applicable.length === 0) {
      const emptyPropertyIds: SafeId<"property">[] = [];
      return emptyPropertyIds;
    }

    const recordAuditEvent = createBackgroundAuditRecorder({
      execution: {
        performer: {
          id: "classification-playbook-router",
          name: "Classification playbook router",
          type: "service",
        },
        trigger: { source: "document-classification", type: "system" },
      },
      organizationId,
      workspaceId,
      userId,
    });

    // One read for the whole batch rather than a pin per playbook.
    const approvedVersions = await loadLatestApprovedVersions({
      tx,
      organizationId,
      playbookDefinitionIds: applicable.map((playbook) => playbook.id),
    });

    const ids: SafeId<"property">[] = [];
    for (const definition of applicable) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each playbook materializes its own columns and table runs; not one query
      const result = await openPlaybookRun({
        tx,
        workspaceId,
        organizationId,
        userId,
        definition,
        latestApprovedVersion: approvedVersions.get(definition.id) ?? null,
        projection: PLAYBOOK_RUN_PROJECTION.COLUMNS,
        recordAuditEvent,
        auditMetadata: ROUTED_AUDIT_METADATA,
      });
      if (!result.ok) {
        // Fire-and-forget background path with no other feedback channel:
        // capture the reason so a per-playbook materialization failure (e.g.
        // hitting the properties cap) is not silently invisible.
        captureError(new Error(result.message), {
          workspaceId,
          playbookId: definition.id,
          status: String(result.status),
        });
        continue;
      }
      if (result.materializedPropertyIds.length === 0) {
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
  // Fire-and-forget: there is no caller to answer, so both a deferred start (a
  // concurrent run holds the workspace; its straggler catch-up, or the next
  // run, still grades these stale ASK columns) and a failed enqueue are
  // recorded rather than surfaced.
  if (
    playbookRunStartOutcome(started.status) !==
    PLAYBOOK_RUN_START_OUTCOME.QUEUED
  ) {
    captureError(new Error("routeClassifiedDocuments.workflow_not_started"), {
      workspaceId,
      status: started.status,
    });
  }
};
