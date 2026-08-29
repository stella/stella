/**
 * Starting one playbook over one matter's files table.
 *
 * Three surfaces do this: the single run a user picks, the auto-run over every
 * applicable playbook, and the classification trigger. What they may differ in
 * is which playbooks they select and what they do with a failure — never in
 * which version of the playbook the review is measured against, nor in whether
 * a durable run records it. So the whole sequence lives here: pin the approved
 * snapshot, resolve the document-type gate, materialize the columns the
 * projection asks for, and open one run per document against that same pin.
 */

import type { PlaybookRunProjection } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import type {
  PlaybookDefinitionForPin,
  PlaybookVersionForPin,
} from "@/api/lib/document-review/resolve-playbook-pin";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";
import { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import type { CreatePlaybookTableRunsResult } from "@/api/lib/document-review/table-run-create";
import {
  materializePlaybookRun,
  resolveScopedGate,
} from "@/api/lib/workflow/materialize-playbook-run";
import type { PlaybookScope } from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import type { McpRequestContext } from "@/api/mcp/context";

/** The live definition a run starts from: what to pin when it was never
 *  approved, plus the scope that gates which documents it reaches. */
export type PlaybookDefinitionForRun = PlaybookDefinitionForPin & {
  scope: PlaybookScope | null;
};

export type OpenPlaybookRunArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  definition: PlaybookDefinitionForRun;
  latestApprovedVersion: PlaybookVersionForPin | null;
  projection: PlaybookRunProjection;
  recordAuditEvent: AuditRecorder;
  /** Extra context merged onto the EXECUTE audit row, e.g. the system/trigger
   *  marker an auto-routed run carries. */
  auditMetadata?: Record<string, unknown>;
  testDependencies?: McpRequestContext["testDependencies"];
};

export type OpenPlaybookRunResult =
  | {
      ok: true;
      playbook: PinnedPlaybook;
      materializedPropertyIds: SafeId<"property">[];
      tableRuns: CreatePlaybookTableRunsResult;
    }
  | { ok: false; status: 400; message: string };

export const openPlaybookRun = async ({
  tx,
  workspaceId,
  organizationId,
  userId,
  definition,
  latestApprovedVersion,
  projection,
  recordAuditEvent,
  auditMetadata,
  testDependencies,
}: OpenPlaybookRunArgs): Promise<OpenPlaybookRunResult> => {
  // Findings are pinned to the version they were measured against, so every
  // surface resolves the same approved snapshot rather than reading the live
  // definition — and the columns below are materialized from that snapshot too,
  // so a table cell and a finding never disagree about the standard.
  const playbook = resolvePlaybookPin({ definition, latestApprovedVersion });

  const gateResult = await resolveScopedGate({
    tx,
    workspaceId,
    organizationId,
    scope: definition.scope,
  });
  if (!gateResult.ok) {
    return gateResult;
  }

  const materializedPropertyIds: SafeId<"property">[] = [];
  if (projection === PLAYBOOK_RUN_PROJECTION.COLUMNS) {
    const materialized = await (
      testDependencies?.materializePlaybookRun ?? materializePlaybookRun
    )({
      tx,
      workspaceId,
      organizationId,
      playbookId: definition.id,
      positions: playbook.definitionSnapshot.positions.items,
      scope: definition.scope,
      recordAuditEvent,
      auditMetadata: { ...auditMetadata, projection },
    });
    if (!materialized.ok) {
      return materialized;
    }
    materializedPropertyIds.push(...materialized.materializedPropertyIds);
  }

  const tableRuns = await (
    testDependencies?.createPlaybookTableRuns ?? createPlaybookTableRuns
  )({
    tx,
    workspaceId,
    organizationId,
    userId,
    playbook,
    docTypeGate: gateResult.gate,
    projection,
  });

  // A projected run is audited by the materializer; an unprojected one writes
  // no column, so its execution is recorded here.
  if (projection === PLAYBOOK_RUN_PROJECTION.NONE) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
      resourceId: definition.id,
      metadata: {
        ...auditMetadata,
        documentRunCount: tableRuns.runs.length,
        playbookProvenance: playbook.provenance,
        projection,
      },
    });
  }

  return { ok: true, playbook, materializedPropertyIds, tableRuns };
};
