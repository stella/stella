/**
 * Which documents a run opens for, exercised end to end through the stored
 * rows: the pin unit tests prove the snapshot carries the approved scope, but
 * nothing upstream of this file proved the two places `openPlaybookRun` spends
 * that scope actually read it: the document-type gate that picks the run's
 * documents, and the scope the materializer gates the run's columns on.
 *
 * The scenario is the issue's reproduction with two documents in the matter:
 * the playbook was approved for NDAs, its live scope was then edited to
 * leases, and the matter holds one document of each type. Reverting either
 * scope read to the live definition must fail a test here: the gate revert
 * moves the run to the lease document, and the materializer revert leaves the
 * run on the NDA document but gates its columns on "Lease".
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewRuns,
  documentTypes,
  entities,
  entityVersions,
  fields,
  playbookDefinitions,
  playbookDefinitionVersions,
  properties,
  propertyDependencies,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import { openPlaybookRun } from "@/api/lib/document-review/open-playbook-run";
import type { OpenPlaybookRunResult } from "@/api/lib/document-review/open-playbook-run";
import type {
  PlaybookPositions,
  PlaybookScope,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: the suite boots the PGlite schema before it can seed anything
setDefaultTimeout(120_000);

const ids = createTestIds();
let db: TestDatabase;

const POSITION_ID = "11111111-1111-4111-8111-111111111111";

const gradedPosition: Position = {
  mode: "graded",
  sourceId: POSITION_ID,
  issue: "Termination notice",
  severity: "high",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [],
        ideal: { source: "inline", text: "Thirty days' written notice." },
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: {
    mode: "manual",
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
};

const positions: PlaybookPositions = { version: 3, items: [gradedPosition] };
const approvedScope: PlaybookScope = { documentTypeKey: "nda" };
const liveScope: PlaybookScope = { documentTypeKey: "lease" };

const classifierId = createSafeId<"property">();
const definitionId = createSafeId<"playbookDefinition">();
const leaseEntityId = createSafeId<"entity">();
const leaseVersionId = createSafeId<"entityVersion">();

let opened: Extract<OpenPlaybookRunResult, { ok: true }>;

const seedDocument = async ({
  entityId,
  versionId,
  name,
  sha256Hex,
  classifiedAs,
}: {
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  name: string;
  sha256Hex: string;
  classifiedAs: "NDA" | "Lease";
}): Promise<void> => {
  await db.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "document",
    name,
  });
  await db.insert(entityVersions).values({
    id: versionId,
    workspaceId: ids.wsA1,
    entityId,
  });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  await db.insert(fields).values([
    {
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      propertyId: ids.filePropertyA1,
      entityVersionId: versionId,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: `${name}.docx`,
        mimeType: DOCX_MIME_TYPE,
        sizeBytes: 1024,
        encrypted: false,
        sha256Hex,
        pdfFileId: null,
      },
    },
    {
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      propertyId: classifierId,
      entityVersionId: versionId,
      content: { version: 1, type: "single-select", value: classifiedAs },
    },
  ]);
};

// timeout: the hook seeds a full tenant and opens a real run end to end
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  // The files-table projection reads only the system file column.
  await db
    .update(properties)
    .set({ system: true })
    .where(eq(properties.id, ids.filePropertyA1));

  await db.insert(documentTypes).values([
    {
      id: createSafeId<"documentType">(),
      organizationId: ids.orgA,
      key: "nda",
      label: "NDA",
    },
    {
      id: createSafeId<"documentType">(),
      organizationId: ids.orgA,
      key: "lease",
      label: "Lease",
    },
  ]);
  await db.insert(properties).values({
    id: classifierId,
    workspaceId: ids.wsA1,
    name: "Document Type",
    content: {
      version: 1,
      type: "single-select",
      options: [
        { value: "NDA", color: "blue" },
        { value: "Lease", color: "green" },
      ],
      fallback: null,
    },
    tool: { version: 1, type: "ai-model", prompt: "Classify this document." },
    status: "fresh",
    role: "document-type-classifier",
  });

  // The fixture's own document is the NDA; a second one is the lease.
  await seedDocument({
    entityId: leaseEntityId,
    versionId: leaseVersionId,
    name: "Lease agreement",
    sha256Hex: "c".repeat(64),
    classifiedAs: "Lease",
  });
  await db.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId: ids.wsA1,
    propertyId: classifierId,
    entityVersionId: ids.entityVersionA1,
    content: { version: 1, type: "single-select", value: "NDA" },
  });

  // Approved for NDAs, then edited to leases without a second approval.
  await db.insert(playbookDefinitions).values({
    id: definitionId,
    organizationId: ids.orgA,
    name: "NDA review",
    positions,
    scope: liveScope,
  });
  await db.insert(playbookDefinitionVersions).values({
    id: createSafeId<"playbookDefinitionVersion">(),
    organizationId: ids.orgA,
    playbookDefinitionId: definitionId,
    version: 1,
    source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
    name: "NDA review",
    positions,
    scope: approvedScope,
    createdBy: ids.userA1,
  });

  const latestApprovedVersion = await loadLatestApprovedVersion({
    tx: asTestRaw<Transaction>(db),
    organizationId: ids.orgA,
    playbookDefinitionId: definitionId,
  });
  if (latestApprovedVersion === null) {
    throw new Error("The seeded approval must resolve");
  }

  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    execution: {
      performer: { type: "user", id: ids.userA1 },
      trigger: { type: "direct" },
    },
  });

  const result = await createSafeDb(
    db,
    [ids.wsA1],
    ids.orgA,
    ids.userA1,
  )(async (tx) =>
    openPlaybookRun({
      tx: asTestRaw<Transaction>(tx),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      definition: {
        id: definitionId,
        name: "NDA review",
        positions,
        scope: liveScope,
      },
      latestApprovedVersion,
      projection: PLAYBOOK_RUN_PROJECTION.COLUMNS,
      recordAuditEvent,
    }),
  );
  if (result.isErr()) {
    throw result.error;
  }
  if (!result.value.ok) {
    throw new Error(`The run was refused: ${result.value.message}`);
  }
  opened = result.value;
}, 300_000);

afterAll(releaseTestDb);

describe("opening a run over a matter with an NDA and a lease document", () => {
  test("only the NDA document gets a run", async () => {
    expect(opened.playbook.definitionSnapshot.scope).toEqual(approvedScope);
    expect(opened.tableRuns.runs.map((run) => run.entityId)).toEqual([
      ids.entityA1,
    ]);

    const stored = await db
      .select({
        entityId: documentReviewRuns.entityId,
        basis: documentReviewRuns.basis,
      })
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.playbookDefinitionId, definitionId));
    expect(stored.map((run) => run.entityId)).toEqual([ids.entityA1]);
    // The durable run records the approved scope it was measured against.
    expect(stored.at(0)?.basis.playbook.definitionSnapshot.scope).toEqual(
      approvedScope,
    );
  });

  test("the materialized columns are gated on the approved type, not the edited one", async () => {
    const gates = await db
      .select({
        propertyId: propertyDependencies.propertyId,
        condition: propertyDependencies.condition,
      })
      .from(propertyDependencies)
      .where(
        and(
          eq(propertyDependencies.workspaceId, ids.wsA1),
          eq(propertyDependencies.dependsOnPropertyId, classifierId),
        ),
      );
    // Both the ASK column and its verdict column carry the gate.
    expect(opened.materializedPropertyIds).toHaveLength(2);
    expect(gates.map((gate) => gate.propertyId).toSorted()).toEqual(
      [...opened.materializedPropertyIds].toSorted(),
    );
    for (const gate of gates) {
      expect(gate.condition).toEqual({
        type: "compare",
        left: { type: "property", propertyId: classifierId },
        op: "eq",
        right: { type: "literal", value: "NDA" },
      });
    }
  });
});
