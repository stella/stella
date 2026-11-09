/**
 * Classification routing spends the approved scope, exercised through the
 * stored rows: an `onClassified` playbook approved for NDAs whose live scope
 * was edited to leases must still route over a matter holding only an NDA,
 * because applicability reads the pinned scope. Selecting the routable set
 * from the live rows instead would hand applicability the edited scope, drop
 * the playbook, and route nothing; this suite fails if that line regresses.
 *
 * The live trigger stays `onClassified` here on purpose: the SQL pre-filter
 * reads it, so this suite covers the scope a fetched playbook is routed by,
 * not which playbooks get fetched (the boundary the router's own comment
 * documents).
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
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentReviewRuns,
  documentTypes,
  fields,
  playbookDefinitions,
  playbookDefinitionVersions,
  properties,
  propertyDependencies,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";
import type {
  PlaybookPositions,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";
import { routeClassifiedDocuments } from "@/api/lib/workflow/route-playbooks";
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

const classifierId = createSafeId<"property">();
const definitionId = createSafeId<"playbookDefinition">();
// Approved to route on classification; the live trigger was then edited to
// manual. The approval still routes it.
const triggerEditedAwayId = createSafeId<"playbookDefinition">();
// Approved as manual; the live trigger was then edited to route on
// classification. The edit has no effect until the playbook is approved again.
const triggerEditedOnId = createSafeId<"playbookDefinition">();

const workflowStarts: { propertyIds: SafeId<"property">[] }[] = [];

// timeout: the hook seeds a full tenant and routes a real classification
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
  // The matter holds a single document, classified as an NDA.
  await db.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId: ids.wsA1,
    propertyId: classifierId,
    entityVersionId: ids.entityVersionA1,
    content: { version: 1, type: "single-select", value: "NDA" },
  });

  // Approved for NDAs on classification; the live scope was edited to
  // leases afterwards, trigger untouched.
  await db.insert(playbookDefinitions).values({
    id: definitionId,
    organizationId: ids.orgA,
    name: "NDA review",
    positions,
    scope: { documentTypeKey: "lease", trigger: "onClassified" },
  });
  await db.insert(playbookDefinitionVersions).values({
    id: createSafeId<"playbookDefinitionVersion">(),
    organizationId: ids.orgA,
    playbookDefinitionId: definitionId,
    version: 1,
    source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
    name: "NDA review",
    positions,
    scope: { documentTypeKey: "nda", trigger: "onClassified" },
    createdBy: ids.userA1,
  });

  await db.insert(playbookDefinitions).values([
    {
      id: triggerEditedAwayId,
      organizationId: ids.orgA,
      name: "NDA review, trigger edited to manual",
      positions,
      scope: { documentTypeKey: "nda", trigger: "manual" },
    },
    {
      id: triggerEditedOnId,
      organizationId: ids.orgA,
      name: "NDA review, trigger edited to classification",
      positions,
      scope: { documentTypeKey: "nda", trigger: "onClassified" },
    },
  ]);
  await db.insert(playbookDefinitionVersions).values([
    {
      id: createSafeId<"playbookDefinitionVersion">(),
      organizationId: ids.orgA,
      playbookDefinitionId: triggerEditedAwayId,
      version: 1,
      source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
      name: "NDA review, trigger edited to manual",
      positions,
      scope: { documentTypeKey: "nda", trigger: "onClassified" },
      createdBy: ids.userA1,
    },
    {
      id: createSafeId<"playbookDefinitionVersion">(),
      organizationId: ids.orgA,
      playbookDefinitionId: triggerEditedOnId,
      version: 1,
      source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
      name: "NDA review, trigger edited to classification",
      positions,
      scope: { documentTypeKey: "nda", trigger: "manual" },
      createdBy: ids.userA1,
    },
  ]);

  const scopedDb: ScopedDb = async (fn) => {
    const result = await createSafeDb(
      db,
      [ids.wsA1],
      ids.orgA,
      ids.userA1,
    )(async (tx) => fn(asTestRaw<Transaction>(tx)));
    if (result.isErr()) {
      throw result.error;
    }
    return result.value;
  };

  await routeClassifiedDocuments({
    workspaceId: ids.wsA1,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scopedDb,
    startWorkflow: async ({ propertyIds }) => {
      workflowStarts.push({ propertyIds });
      return { status: "started" satisfies WorkflowStartStatus };
    },
    classifier: { id: classifierId },
  });
}, 300_000);

afterAll(releaseTestDb);

describe("classification routing on the approved scope", () => {
  test("routes the playbook and starts one workflow over its columns", async () => {
    expect(workflowStarts).toHaveLength(1);

    const materialized = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.playbookDefinitionId, definitionId));
    expect(materialized).toHaveLength(2);
    const started = workflowStarts.at(0)?.propertyIds ?? [];
    for (const row of materialized) {
      expect(started).toContain(row.id);
    }

    const runs = await db
      .select({ entityId: documentReviewRuns.entityId })
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.playbookDefinitionId, definitionId));
    expect(runs.map((run) => run.entityId)).toEqual([ids.entityA1]);
  });

  test("gates the routed columns on the approved type", async () => {
    const gates = await db
      .select({ condition: propertyDependencies.condition })
      .from(propertyDependencies)
      .innerJoin(properties, eq(properties.id, propertyDependencies.propertyId))
      .where(
        and(
          eq(propertyDependencies.workspaceId, ids.wsA1),
          eq(propertyDependencies.dependsOnPropertyId, classifierId),
          eq(properties.playbookDefinitionId, definitionId),
        ),
      );
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      expect(gate.condition).toEqual({
        type: "compare",
        left: { type: "property", propertyId: classifierId },
        op: "eq",
        right: { type: "literal", value: "NDA" },
      });
    }
  });

  test("routes a playbook whose trigger was edited away after approval", async () => {
    const materialized = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.playbookDefinitionId, triggerEditedAwayId));
    expect(materialized).toHaveLength(2);
    const started = workflowStarts.at(0)?.propertyIds ?? [];
    for (const row of materialized) {
      expect(started).toContain(row.id);
    }
  });

  test("does not route a playbook whose trigger was edited on after approval", async () => {
    const materialized = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.playbookDefinitionId, triggerEditedOnId));
    expect(materialized).toEqual([]);
    const runs = await db
      .select({ id: documentReviewRuns.id })
      .from(documentReviewRuns)
      .where(eq(documentReviewRuns.playbookDefinitionId, triggerEditedOnId));
    expect(runs).toEqual([]);
  });
});
