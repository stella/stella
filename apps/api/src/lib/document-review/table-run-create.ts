/**
 * Opening durable review runs for a whole matter.
 *
 * Running a playbook over a files table is one review per document, not one
 * review of a table: each document gets its own run, pinned to its own version
 * and content hash, carrying the playbook snapshot by value exactly as a
 * single-document review does. What differs is who executes them — see
 * `PlaybookRunProjection`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { PlaybookRunProjection } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { documentReviewRuns, entities, fields } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  DocumentReviewRunExecutor,
  PinnedPlaybook,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type { DocTypeGate } from "@/api/lib/workflow/materialize-playbook-run";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * Documents one playbook run opens durable review runs for.
 *
 * A module constant rather than a `LIMITS` entry: `LIMITS` is served whole on
 * the workspace read, so every field added there is paid for on a hot route by
 * every client, and nothing outside this module needs this number.
 *
 * The bound is about how much one run may write, not about how many documents a
 * matter may hold: each run pins the playbook snapshot by value.
 */
export const PLAYBOOK_RUN_DOCUMENTS_MAX = 500;

export type CreatedTableRun = {
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
};

export type CreatePlaybookTableRunsResult = {
  runs: CreatedTableRun[];
  /** Documents already holding an active review; a second one would spend
   *  twice and race the first to the same findings. */
  skippedActiveCount: number;
  /** Documents past `PLAYBOOK_RUN_DOCUMENTS_MAX` that this run does not cover.
   *  Never silently zero: the caller reports or refuses. */
  uncoveredCount: number;
  /** The finding count every created run promises. */
  expectedFindingCount: number;
};

export type CreatePlaybookTableRunsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  playbook: PinnedPlaybook;
  /** Resolved document-type gate, or null for a workspace-wide playbook. */
  docTypeGate: DocTypeGate | null;
  projection: PlaybookRunProjection;
};

/** One DOCX document of the matter, pinned as the run will record it. */
type TargetDocument = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fileFieldId: SafeId<"field">;
  contentSha256: string;
};

const loadTargetDocuments = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  docTypeGate: DocTypeGate | null,
  limit: number,
): Promise<TargetDocument[]> => {
  // A scoped playbook reviews only the documents its classifier already routed
  // to it, mirroring the gate the materialized columns carry. A document whose
  // type has not been classified yet is not reviewed rather than reviewed
  // against the wrong standard.
  const gateCondition =
    docTypeGate === null
      ? undefined
      : sql`EXISTS (
          SELECT 1
            FROM ${fields} AS gate_field
           WHERE gate_field.entity_version_id = ${entities.currentVersionId}
             AND gate_field.workspace_id = ${workspaceId}
             AND gate_field.property_id = ${docTypeGate.propertyId}
             AND gate_field.content->>'value' = ${docTypeGate.label}
        )`;

  const rows = await tx
    .select({
      entityId: entities.id,
      entityVersionId: fields.entityVersionId,
      fileFieldId: fields.id,
      content: fields.content,
    })
    .from(entities)
    .innerJoin(
      fields,
      and(
        eq(fields.entityVersionId, entities.currentVersionId),
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'file'`,
        sql`${fields.content}->>'mimeType' = ${DOCX_MIME_TYPE}`,
      ),
    )
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "document"),
        gateCondition,
      ),
    )
    .orderBy(entities.createdAt, entities.id, fields.id)
    .limit(limit);

  const documents: TargetDocument[] = [];
  for (const row of rows) {
    if (row.content.type !== "file") {
      continue;
    }
    documents.push({
      entityId: row.entityId,
      entityVersionId: row.entityVersionId,
      fileFieldId: row.fileFieldId,
      contentSha256: row.content.sha256Hex,
    });
  }
  return documents;
};

export const createPlaybookTableRuns = async ({
  tx,
  workspaceId,
  organizationId,
  userId,
  playbook,
  docTypeGate,
  projection,
}: CreatePlaybookTableRunsArgs): Promise<CreatePlaybookTableRunsResult> => {
  // Under `columns` the property DAG carries the run, so it starts already
  // claimed and no job is enqueued for it. Under `none` the review worker owns
  // it, and it waits in `queued` for the job the caller enqueues. Which one it
  // is decides what the run can promise, so the executor is resolved before the
  // plan rather than after it.
  const startsClaimed = projection === PLAYBOOK_RUN_PROJECTION.COLUMNS;
  const executor: DocumentReviewRunExecutor = startsClaimed
    ? DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE
    : DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER;
  // A table run compares against the playbook alone: no reference document is
  // pinned, so there is no side for a comparison to be judged for.
  const basis: DocumentReviewRunBasis = {
    playbook,
    references: [],
    perspective: NEUTRAL_PERSPECTIVE,
  };
  const { expectedFindingCount } = planReviewRun({ basis, executor });
  if (expectedFindingCount === 0) {
    return {
      runs: [],
      skippedActiveCount: 0,
      uncoveredCount: 0,
      expectedFindingCount: 0,
    };
  }

  // One row past the cap is what makes "there are more" a fact rather than a
  // guess, without counting the whole table.
  const documents = await loadTargetDocuments(
    tx,
    workspaceId,
    docTypeGate,
    PLAYBOOK_RUN_DOCUMENTS_MAX + 1,
  );
  const uncoveredCount = Math.max(
    documents.length - PLAYBOOK_RUN_DOCUMENTS_MAX,
    0,
  );
  const covered = documents.slice(0, PLAYBOOK_RUN_DOCUMENTS_MAX);
  if (covered.length === 0) {
    return {
      runs: [],
      skippedActiveCount: 0,
      uncoveredCount,
      expectedFindingCount,
    };
  }

  const active = await tx
    .select({ entityId: documentReviewRuns.entityId })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.workspaceId, workspaceId),
        inArray(
          documentReviewRuns.entityId,
          covered.map((document) => document.entityId),
        ),
        inArray(documentReviewRuns.status, [
          ...DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
        ]),
      ),
    );
  const busyEntityIds = new Set(active.map((row) => row.entityId));

  const pending = covered.filter(
    (document) => !busyEntityIds.has(document.entityId),
  );
  if (pending.length === 0) {
    return {
      runs: [],
      skippedActiveCount: covered.length,
      uncoveredCount,
      expectedFindingCount,
    };
  }

  const status = startsClaimed ? "running" : "queued";
  const startedAt = startsClaimed ? new Date() : null;

  const offered = pending.map((document) => ({
    runId: createSafeId<"documentReviewRun">(),
    entityId: document.entityId,
    fileFieldId: document.fileFieldId,
    entityVersionId: document.entityVersionId,
    contentSha256: document.contentSha256,
  }));

  // One statement for the whole matter, with the pinned snapshot bound once
  // instead of once per document. A row-per-document insert would ship the
  // playbook snapshot again for every document — the bytes the run pins by
  // value, multiplied by the size of the matter — so the documents ride in as a
  // five-column VALUES list and the constants are joined onto them.
  //
  // `::text::jsonb`, never a bare `::jsonb`: a bare cast fixes the bind
  // parameter's type, so the driver re-encodes the already-serialized string
  // and the column ends up holding a jsonb *string* instead of the object.
  const documentTuples = offered.map(
    (run) =>
      sql`(${run.runId}::uuid, ${run.entityId}::uuid, ${run.fileFieldId}::uuid, ${run.entityVersionId}::uuid, ${run.contentSha256}::varchar)`,
  );

  // audit: skip — the caller audits the playbook run once.
  await tx.execute(sql`
    INSERT INTO ${documentReviewRuns} (
      id, organization_id, workspace_id, entity_id, file_field_id,
      entity_version_id, content_sha256, playbook_definition_id, basis,
      status, executor, total, requested_by, started_at
    )
    SELECT target.id,
           ${organizationId}::varchar,
           ${workspaceId}::uuid,
           target.entity_id,
           target.file_field_id,
           target.entity_version_id,
           target.content_sha256,
           ${playbook.definitionId}::uuid,
           ${JSON.stringify(basis)}::text::jsonb,
           ${status}::text,
           ${executor}::text,
           ${expectedFindingCount}::integer,
           ${userId}::text,
           ${startedAt}::timestamptz
      FROM (VALUES ${sql.join(documentTuples, sql`, `)})
        AS target(id, entity_id, file_field_id, entity_version_id, content_sha256)
    ON CONFLICT DO NOTHING`);

  // Read back what actually landed rather than assuming it was everything
  // offered: the active-run check above loses a race against a review started
  // in the same instant, the partial unique index catches it, and that loser
  // simply gets no run. A `RETURNING` clause would say the same thing, but the
  // two drivers in play disagree on the shape of a raw statement's result, so
  // the confirmation is a plain typed read.
  const created = await tx
    .select({
      runId: documentReviewRuns.id,
      entityId: documentReviewRuns.entityId,
    })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.workspaceId, workspaceId),
        inArray(
          documentReviewRuns.id,
          offered.map((run) => run.runId),
        ),
      ),
    );

  return {
    runs: created,
    skippedActiveCount: covered.length - pending.length,
    uncoveredCount,
    expectedFindingCount,
  };
};
