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
import type { DocumentReviewTopic } from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
} from "@/api/lib/document-review/run-contract";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { LIMITS } from "@/api/lib/limits";
import type { DocTypeGate } from "@/api/lib/workflow/materialize-playbook-run";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { selectEnabledPositions } from "@/api/lib/workflow/position-runtime";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** `document_review_findings.topic_title` is varchar(256). */
const TOPIC_TITLE_MAX_LENGTH = 256;
/** Rows inserted per statement. Each run embeds the playbook snapshot and the
 *  topic list by value, so the batch is small on purpose. */
const RUN_INSERT_CHUNK = 50;

export type CreatedTableRun = {
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
};

export type CreatePlaybookTableRunsResult = {
  runs: CreatedTableRun[];
  /** Documents already holding an active review; a second one would spend
   *  twice and race the first to the same findings. */
  skippedActiveCount: number;
  /** Documents past `LIMITS.playbookRunDocumentsMax` that this run does not
   *  cover. Never silently zero: the caller reports or refuses. */
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

/**
 * The topics a table run confirms on the reviewer's behalf: every enabled
 * position the playbook carries.
 *
 * Which ones depends on the projection, because the two produce findings from
 * different engines. Under `columns` only a graded position materializes a
 * verdict column, so only a graded position can yield a finding; an
 * extract-only position stays what it has always been on the table, an ASK
 * column. Under `none` no column exists to hold anything, so an extract-only
 * position's value is carried by a finding with no verdict, exactly as the
 * single-document review records it.
 */
export const buildTableRunTopics = (
  positions: readonly Position[],
  projection: PlaybookRunProjection,
): DocumentReviewTopic[] => {
  const enabled = selectEnabledPositions(positions);
  const included =
    projection === PLAYBOOK_RUN_PROJECTION.COLUMNS
      ? enabled.filter((position) => position.mode === "graded")
      : enabled;
  return included.map((position) => ({
    type: "playbook",
    topicId: position.sourceId,
    positionId: position.sourceId,
    title: position.issue.slice(0, TOPIC_TITLE_MAX_LENGTH),
    context: "",
    included: true,
  }));
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
  const topics = buildTableRunTopics(
    playbook.definitionSnapshot.positions.items,
    projection,
  );
  const basis = { type: "playbook", playbook } as const;
  const { expectedFindingCount } = planReviewRun({ basis, topics });
  if (expectedFindingCount === 0) {
    return {
      runs: [],
      skippedActiveCount: 0,
      uncoveredCount: 0,
      expectedFindingCount: 0,
    };
  }

  const cap = LIMITS.playbookRunDocumentsMax;
  // One row past the cap is what makes "there are more" a fact rather than a
  // guess, without counting the whole table.
  const documents = await loadTargetDocuments(
    tx,
    workspaceId,
    docTypeGate,
    cap + 1,
  );
  const uncoveredCount = Math.max(documents.length - cap, 0);
  const covered = documents.slice(0, cap);
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

  // Under `columns` the property DAG carries the run, so it starts already
  // claimed and no job is enqueued for it. Under `none` the review worker owns
  // it, and it waits in `queued` for the job the caller enqueues.
  const startsClaimed = projection === PLAYBOOK_RUN_PROJECTION.COLUMNS;
  const startedAt = new Date();
  const rows = covered
    .filter((document) => !busyEntityIds.has(document.entityId))
    .map((document) => ({
      id: createSafeId<"documentReviewRun">(),
      organizationId,
      workspaceId,
      entityId: document.entityId,
      fileFieldId: document.fileFieldId,
      entityVersionId: document.entityVersionId,
      contentSha256: document.contentSha256,
      basis,
      topics,
      status: startsClaimed ? ("running" as const) : ("queued" as const),
      executor: startsClaimed
        ? DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE
        : DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
      total: expectedFindingCount,
      requestedBy: userId,
      ...(startsClaimed ? { startedAt } : {}),
    }));

  const runs: CreatedTableRun[] = [];
  for (let index = 0; index < rows.length; index += RUN_INSERT_CHUNK) {
    const chunk = rows.slice(index, index + RUN_INSERT_CHUNK);
    // The active-run check above loses a race against a review started in the
    // same instant; the partial unique index catches it, and the loser simply
    // gets no run. audit: skip — the caller audits the playbook run once.
    // oxlint-disable-next-line no-await-in-loop -- one shared transaction: chunked inserts cannot run in parallel on a single connection
    const inserted = await tx
      .insert(documentReviewRuns)
      .values(chunk)
      .onConflictDoNothing()
      .returning({
        runId: documentReviewRuns.id,
        entityId: documentReviewRuns.entityId,
      });
    runs.push(...inserted);
  }

  return {
    runs,
    skippedActiveCount: covered.length - rows.length,
    uncoveredCount,
    expectedFindingCount,
  };
};
