import { panic } from "better-result";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { ConditionNode } from "@stll/conditions";

import type { Transaction } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
import type {
  PlaybookVerdictTool,
  PropertyTool,
} from "@/api/db/schema-validators";
import type {
  EffectiveAsk,
  GradedPosition,
} from "@/api/handlers/playbooks/position-runtime";
import {
  gradedPositionRule,
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/handlers/playbooks/position-runtime";
import type {
  PlaybookScope,
  Position,
  PositionRule,
  PositionSeverity,
  ResolvedTiers,
} from "@/api/handlers/playbooks/positions";
import {
  loadClauseSnapshots,
  resolveTiers,
} from "@/api/handlers/playbooks/resolve-standards";
import { buildVerdictContent } from "@/api/handlers/playbooks/verdict-tiers";
import { createDefaultTool } from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { remapNodePropertyIds } from "@/api/lib/conditions/ast-utils";
import { LIMITS } from "@/api/lib/limits";

const buildAskTool = (ask: EffectiveAsk): PropertyTool => {
  const question = ask.question.trim();
  const useAi = ask.content.type !== "file" && question.length > 0;
  return createDefaultTool({
    dependencies: [],
    prompt: useAi ? question : undefined,
    toolType: useAi ? "ai-model" : "manual-input",
  });
};

const buildVerdictTool = ({
  askPropertyId,
  sourceId,
  rule,
  severity,
  tiers,
}: {
  askPropertyId: SafeId<"property">;
  sourceId: string;
  rule: PositionRule;
  severity: PositionSeverity;
  tiers: ResolvedTiers;
}): PlaybookVerdictTool => {
  // A propertyConstraint condition is authored against the position's own value
  // via a `property` operand whose id is the position `sourceId`; rewrite that
  // self-reference to the materialized ASK property so the verdict engine
  // evaluates the condition over the real extracted field.
  const remappedRule =
    rule.kind === "propertyConstraint"
      ? {
          kind: "propertyConstraint" as const,
          condition: remapNodePropertyIds(rule.condition, (id) =>
            id === sourceId ? askPropertyId : id,
          ),
        }
      : rule;

  return {
    version: 1,
    type: "playbook-verdict",
    askPropertyId,
    rule: remappedRule,
    severity,
    tiers,
  };
};

type DocTypeGate = {
  propertyId: SafeId<"property">;
  condition: ConditionNode;
  // The resolved taxonomy label the classifier field must equal for a row to
  // match; ephemeral review compares the active document's classification
  // against it directly (dependency-row consumers ignore this field).
  label: string;
};

// The workspace's "Document Type" classifier: a single-select column computed by
// an AI model. The column set is bounded per workspace (LIMITS.propertiesCount),
// content/tool are JSONB, so the single-select + ai-model checks run in app code
// rather than the WHERE clause. Null when the workspace has no matching column.
export const resolveDocTypeClassifier = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<{ id: SafeId<"property"> } | null> => {
  const candidates = await tx
    .select({
      id: properties.id,
      content: properties.content,
      tool: properties.tool,
    })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        sql`lower(trim(${properties.name})) = 'document type'`,
      ),
    );
  const classifier = candidates.find(
    (row) =>
      row.content.type === "single-select" && row.tool.type === "ai-model",
  );
  return classifier ? { id: classifier.id } : null;
};

// A playbook scoped to a document TYPE gates its materialized columns on the
// workspace's "Document Type" classifier, so a row only extracts/grades when
// its classified type matches. Returns null (ungated, legacy behavior) when the
// scope's type slug is unknown for the org or the workspace has no matching
// single-select AI classifier.
export const resolveDocTypeGate = async ({
  tx,
  workspaceId,
  organizationId,
  documentTypeKey,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  documentTypeKey: string;
}): Promise<DocTypeGate | null> => {
  const documentType = await tx.query.documentTypes.findFirst({
    where: {
      organizationId: { eq: organizationId },
      key: { eq: documentTypeKey },
    },
    columns: { label: true },
  });
  if (!documentType) {
    return null;
  }

  const classifier = await resolveDocTypeClassifier(tx, workspaceId);
  if (!classifier) {
    return null;
  }

  return {
    propertyId: classifier.id,
    condition: {
      type: "compare",
      left: { type: "property", propertyId: classifier.id },
      op: "eq",
      right: { type: "literal", value: documentType.label },
    },
    label: documentType.label,
  };
};

type ScopedGateResult =
  | { ok: true; gate: DocTypeGate | null }
  | { ok: false; status: 400; message: string };

// Resolves a playbook's document-type gate, rejecting a scoped playbook whose
// classifier does not resolve (which would otherwise materialize ungated and
// grade every document in the workspace).
export const resolveScopedGate = async ({
  tx,
  workspaceId,
  organizationId,
  scope,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  scope: PlaybookScope | null;
}): Promise<ScopedGateResult> => {
  const docTypeKey = scope?.documentTypeKey;
  if (!docTypeKey) {
    return { ok: true, gate: null };
  }
  const gate = await resolveDocTypeGate({
    tx,
    workspaceId,
    organizationId,
    documentTypeKey: docTypeKey,
  });
  if (gate === null) {
    return {
      ok: false,
      status: 400,
      message:
        "This playbook is scoped to a document type, but the workspace has no matching Document Type classifier to gate on.",
    };
  }
  return { ok: true, gate };
};

export type MaterializePlaybookRunResult =
  | { ok: true; materializedPropertyIds: SafeId<"property">[] }
  | { ok: false; status: 400; message: string };

type MaterializePlaybookRunArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  playbookId: SafeId<"playbookDefinition">;
  positions: readonly Position[];
  scope: PlaybookScope | null;
  recordAuditEvent: AuditRecorder;
};

// Materialize one playbook's ASK + verdict columns (and their dependencies:
// the file input, the doc-type gate, and the verdict→ask edge) into the
// workspace, upserting in place by `playbookSourceId` so a re-run maps back to
// the same columns instead of duplicating them. Returns the ids to extract;
// the caller starts the workflow once over the union across playbooks. Shared
// by the single-playbook run and the auto-run batch so the materialization
// rules cannot drift between the two surfaces.
export const materializePlaybookRun = async ({
  tx,
  workspaceId,
  organizationId,
  playbookId,
  positions,
  scope,
  recordAuditEvent,
}: MaterializePlaybookRunArgs): Promise<MaterializePlaybookRunResult> => {
  if (positions.length === 0) {
    return { ok: true, materializedPropertyIds: [] };
  }

  await lockWorkspacePropertyWrites(tx, workspaceId);

  // When the playbook is scoped to a document type, gate every materialized
  // column on the workspace's "Document Type" classifier so only matching
  // documents extract/grade. Null = ungated fallback.
  // Resolve the document-type gate (null when the playbook is unscoped). A
  // scoped playbook whose classifier does not resolve is rejected rather than
  // materialized ungated (which would grade every document); the auto-run path
  // already skips scoped playbooks in that case.
  const gateResult = await resolveScopedGate({
    tx,
    workspaceId,
    organizationId,
    scope,
  });
  if (!gateResult.ok) {
    return gateResult;
  }
  const docTypeGate = gateResult.gate;

  // Drop disabled positions before materializing. A disabled position emits no
  // columns; any it previously owned falls out of the emitted set below and is
  // deleted as obsolete, so toggling `enabled` off tears its columns down.
  const enabledPositions = selectEnabledPositions(positions);

  const clauseSnapshots = await loadClauseSnapshots(
    tx,
    organizationId,
    enabledPositions,
  );

  // The AI extraction batch only receives files that are among a property's
  // dependency inputs (generate-batch resolves documents from `batch.inputs`),
  // so every AI ASK column must depend on the workspace's file column to
  // actually read the document.
  const systemFileProperty = await tx.query.properties.findFirst({
    where: {
      workspaceId: { eq: workspaceId },
      system: { eq: true },
    },
    columns: { id: true, content: true },
  });
  // The workspace's system file property is a structural invariant every AI ASK
  // column depends on to read the document; a missing or non-file one means the
  // workspace was provisioned wrong, so fail fast rather than materialize columns
  // that can never receive their document input.
  if (!systemFileProperty || systemFileProperty.content.type !== "file") {
    panic("Workspace system file property is missing or not a file column");
  }
  const filePropertyId = systemFileProperty.id;

  const sourceIds = enabledPositions.map((position) => position.sourceId);
  const owned = await tx
    .select({
      id: properties.id,
      playbookSourceId: properties.playbookSourceId,
      tool: properties.tool,
    })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        or(
          eq(properties.playbookDefinitionId, playbookId),
          and(
            isNull(properties.playbookDefinitionId),
            inArray(properties.playbookSourceId, sourceIds),
          ),
        ),
      ),
    );

  // ASK vs verdict materialized columns share a position's sourceId; the tool
  // type disambiguates which existing row to update in place.
  const askIdBySourceId = new Map<string, SafeId<"property">>();
  const verdictIdBySourceId = new Map<string, SafeId<"property">>();
  for (const row of owned) {
    if (row.playbookSourceId === null) {
      continue;
    }
    if (row.tool.type === "playbook-verdict") {
      verdictIdBySourceId.set(row.playbookSourceId, row.id);
    } else {
      askIdBySourceId.set(row.playbookSourceId, row.id);
    }
  }

  const existingCount = await tx.$count(
    properties,
    eq(properties.workspaceId, workspaceId),
  );

  const askRows: (typeof properties.$inferInsert)[] = [];
  const verdictRows: (typeof properties.$inferInsert)[] = [];
  const dependencyRows: (typeof propertyDependencies.$inferInsert)[] = [];
  const materializedPropertyIds: SafeId<"property">[] = [];
  const verdictPropertyIds: SafeId<"property">[] = [];
  let newCount = 0;

  for (const position of enabledPositions) {
    const ask = resolveEffectiveAsk(position);
    const askTool = buildAskTool(ask);
    const askId =
      askIdBySourceId.get(position.sourceId) ?? createSafeId<"property">();
    if (!askIdBySourceId.has(position.sourceId)) {
      newCount += 1;
    }

    askRows.push({
      id: askId,
      workspaceId,
      name: position.issue,
      content: ask.content,
      tool: askTool,
      status: askTool.type === "ai-model" ? "stale" : "fresh",
      playbookSourceId: position.sourceId,
      playbookDefinitionId: playbookId,
    });
    materializedPropertyIds.push(askId);

    // Wire the AI ASK column to the file column so the extraction batch
    // receives the document as input (see systemFileProperty above).
    if (askTool.type === "ai-model") {
      dependencyRows.push({
        workspaceId,
        propertyId: askId,
        dependsOnPropertyId: filePropertyId,
        condition: null,
      });
    }

    // Gate the ASK column on the document-type classifier so a non-matching
    // document never extracts (the condition short-circuits its computation in
    // the trigger engine).
    if (docTypeGate !== null) {
      dependencyRows.push({
        workspaceId,
        propertyId: askId,
        dependsOnPropertyId: docTypeGate.propertyId,
        condition: docTypeGate.condition,
      });
    }

    // Extract-only positions materialize a value column with no verdict.
    if (position.mode === "extract") {
      continue;
    }
    const gradedPosition: GradedPosition = position;

    const verdictId =
      verdictIdBySourceId.get(position.sourceId) ?? createSafeId<"property">();
    if (!verdictIdBySourceId.has(position.sourceId)) {
      newCount += 1;
    }
    verdictPropertyIds.push(verdictId);

    verdictRows.push({
      id: verdictId,
      workspaceId,
      name: `${position.issue} (verdict)`.slice(0, 256),
      content: buildVerdictContent(),
      tool: buildVerdictTool({
        askPropertyId: askId,
        sourceId: gradedPosition.sourceId,
        rule: gradedPositionRule(gradedPosition),
        severity: gradedPosition.severity,
        tiers: resolveTiers(gradedPosition, clauseSnapshots),
      }),
      status: "stale",
      playbookSourceId: position.sourceId,
      playbookDefinitionId: playbookId,
    });
    materializedPropertyIds.push(verdictId);

    // The verdict is graded after its ASK extraction; the DAG schedules it a
    // level later via this dependency (no gate condition).
    dependencyRows.push({
      workspaceId,
      propertyId: verdictId,
      dependsOnPropertyId: askId,
      condition: null,
    });

    // The verdict inherits the gate transitively via its ASK dependency, but
    // gating it directly skips non-matching documents entirely rather than
    // grading a missing ASK value.
    if (docTypeGate !== null) {
      dependencyRows.push({
        workspaceId,
        propertyId: verdictId,
        dependsOnPropertyId: docTypeGate.propertyId,
        condition: docTypeGate.condition,
      });
    }
  }

  const upsertProperties = async (rows: (typeof properties.$inferInsert)[]) => {
    if (rows.length === 0) {
      return;
    }
    // audit: skip — the playbook run is audited once via recordAuditEvent in
    // the enclosing transaction; this helper only upserts materialized rows.
    await tx
      .insert(properties)
      .values(rows)
      .onConflictDoUpdate({
        target: properties.id,
        set: {
          name: sql`excluded.name`,
          content: sql`excluded.content`,
          tool: sql`excluded.tool`,
          status: sql`excluded.status`,
          playbookDefinitionId: sql`excluded.playbook_definition_id`,
        },
      });
  };

  const emittedAskIds = new Set(askRows.map((row) => row.id));
  const emittedVerdictIds = new Set(verdictPropertyIds);
  const obsoleteVerdictIds = [...verdictIdBySourceId.values()].filter(
    (id) => !emittedVerdictIds.has(id),
  );
  const obsoleteAskIds = [...askIdBySourceId.values()].filter(
    (id) => !emittedAskIds.has(id),
  );
  const retainedCount =
    existingCount - obsoleteVerdictIds.length - obsoleteAskIds.length;
  if (retainedCount + newCount > LIMITS.propertiesCount) {
    return { ok: false, status: 400, message: "Properties limit reached" };
  }

  // ASK rows first so the verdict rows' `askPropertyId` FK targets exist.
  await upsertProperties(askRows);
  await upsertProperties(verdictRows);

  // Drop columns this pass no longer produces: verdicts for positions edited back
  // to extract-only, and both ASK/verdict columns for removed positions. Verdicts
  // go first because their dependency edge restricts deleting the ASK column.
  if (obsoleteVerdictIds.length > 0) {
    await tx
      .delete(properties)
      .where(
        and(
          eq(properties.workspaceId, workspaceId),
          inArray(properties.id, obsoleteVerdictIds),
        ),
      );
  }
  if (obsoleteAskIds.length > 0) {
    await tx
      .delete(properties)
      .where(
        and(
          eq(properties.workspaceId, workspaceId),
          inArray(properties.id, obsoleteAskIds),
        ),
      );
  }

  // Replace the materialized columns' dependencies wholesale: clear the existing
  // edges for every ASK/verdict id this run owns, then insert the current set.
  // An upsert alone would leave behind edges the run no longer emits — e.g. a
  // playbook narrowed from a document-type scope back to All keeps its stale
  // classifier gate, or an ASK flipped AI→manual keeps its file dependency — so
  // the workflow planner would keep gating/skipping under the old wiring.
  const materializedIds = materializedPropertyIds;
  if (materializedIds.length > 0) {
    await tx
      .delete(propertyDependencies)
      .where(
        and(
          eq(propertyDependencies.workspaceId, workspaceId),
          inArray(propertyDependencies.propertyId, materializedIds),
        ),
      );
  }

  if (dependencyRows.length > 0) {
    await tx.insert(propertyDependencies).values(dependencyRows);
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.EXECUTE,
    resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
    resourceId: playbookId,
    changes: {
      run: {
        old: null,
        new: { materializedPropertyCount: materializedPropertyIds.length },
      },
    },
  });

  return { ok: true, materializedPropertyIds };
};
