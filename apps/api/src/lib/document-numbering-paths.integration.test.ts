import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  documentCounters,
  documentReferenceCounters,
  entities,
  matterCounters,
  entityVersions,
  organizationSettings,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import clipEntity from "@/api/handlers/entities/clip";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import { createDuplicateWorkspace } from "@/api/handlers/workspaces/duplicate";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS,
  toScopeKey,
} from "@/api/lib/matter-reference";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { runNumberingCopy } from "@/api/tests/helpers/document-numbering-copy";
import { runNumberingUpload } from "@/api/tests/helpers/document-numbering-upload";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
let originalNumberingSettings:
  | Pick<
      typeof organizationSettings.$inferSelect,
      "matterNumberPattern" | "matterNumberPadding"
    >
  | undefined;
const createdWorkspaceIds: SafeId<"workspace">[] = [];
const testReferences: string[] = [];
const recordAuditEvent: AuditRecorder = async () => undefined;

const duplicateWorkspace = createDuplicateWorkspace({
  enqueueDocumentProcessingRun: async () => undefined,
  enqueueEntitySearchRepairs: async () => undefined,
  enqueueWorkspaceSearchRepairs: async () => undefined,
  flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
  flushWorkspaceSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
  requestNativeExtractionRuns: async ({ requests }) =>
    requests.map(() => createSafeId<"documentProcessingRun">()),
});

const createMatter = async (reference: string) => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: `Numbering path ${reference}`,
    reference,
    status: "active",
  });
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
};

const createFileProperty = async (workspaceId: SafeId<"workspace">) => {
  const propertyId = createSafeId<"property">();
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "Documents",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
    system: true,
    kinds: ["document"],
  });
  return propertyId;
};

const scopeFor = (workspaceId: SafeId<"workspace">) =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [workspaceId], ids.orgA, ids.userA1));

const expectOk = <T, E>(result: Result<T, E>): T => {
  if (Result.isError(result)) {
    panic("Numbering path failed", result.error);
  }
  return result.value;
};

type MatrixCase = {
  ledger: "absent" | "present";
  owner: "self" | "other" | "null";
  lastValue: 0 | 5 | 30;
  counter: "absent" | "10";
  rename: "unchanged" | "away-and-back";
};

const cases: MatrixCase[] = [
  ...(["self", "other", "null"] as const).flatMap((owner) =>
    ([0, 5, 30] as const).flatMap((lastValue) =>
      (["absent", "10"] as const).flatMap((counter) =>
        (["unchanged", "away-and-back"] as const).map((rename) => ({
          ledger: "present" as const,
          owner,
          lastValue,
          counter,
          rename,
        })),
      ),
    ),
  ),
  ...(["absent", "10"] as const).flatMap((counter) =>
    (["unchanged", "away-and-back"] as const).map((rename) => ({
      ledger: "absent" as const,
      owner: "null" as const,
      lastValue: 0 as const,
      counter,
      rename,
    })),
  ),
];

type RestoreMatterStateOptions = {
  scenario: MatrixCase;
  reference: string;
  matter: SafeId<"workspace">;
  other: SafeId<"workspace">;
};

const restoreMatterState = async ({
  scenario,
  reference,
  matter,
  other,
}: RestoreMatterStateOptions) => {
  await testDb
    .delete(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, reference),
      ),
    );
  await testDb
    .delete(documentCounters)
    .where(eq(documentCounters.workspaceId, matter));
  if (scenario.ledger === "present") {
    const owners = { self: matter, other, null: null };
    await testDb.insert(documentReferenceCounters).values({
      id: createSafeId<"documentReferenceCounter">(),
      organizationId: ids.orgA,
      reference,
      workspaceId: owners[scenario.owner],
      lastValue: scenario.lastValue,
    });
  }
  if (scenario.counter === "10") {
    await testDb.insert(documentCounters).values({
      id: createSafeId<"documentCounter">(),
      workspaceId: matter,
      lastValue: 10,
    });
  }
};

const seedMatterState = async (
  scenario: MatrixCase,
  reference: string,
): Promise<{ matter: SafeId<"workspace">; other: SafeId<"workspace"> }> => {
  testReferences.push(reference);
  const matter = await createMatter(reference);
  const other = await createMatter(`${reference}-OTHER`);
  await restoreMatterState({ scenario, reference, matter, other });
  if (scenario.rename === "away-and-back") {
    await testDb
      .update(workspaces)
      .set({ reference: `${reference}-TEMP` })
      .where(eq(workspaces.id, matter));
    await testDb
      .update(workspaces)
      .set({ reference })
      .where(eq(workspaces.id, matter));
  }
  return { matter, other };
};

const expectedInitialFloor = (scenario: MatrixCase) =>
  Math.max(
    scenario.ledger === "present" ? scenario.lastValue : 0,
    scenario.counter === "10" ? 10 : 0,
  );

const assertMatterIssuance = async ({
  entityIds,
  expectedLastValue,
  expectedCounterValue = expectedLastValue,
  matter,
  reference,
}: {
  entityIds: SafeId<"entity">[];
  expectedLastValue: number;
  expectedCounterValue?: number | null;
  matter: SafeId<"workspace">;
  reference: string;
}) => {
  const entitiesWritten = await testDb
    .select({ id: entities.id, docSequence: entities.docSequence })
    .from(entities)
    .where(inArray(entities.id, entityIds));
  const versionRows = await testDb
    .select({ stamp: entityVersions.stamp })
    .from(entityVersions)
    .where(inArray(entityVersions.entityId, entityIds));
  const stamps = versionRows.flatMap(({ stamp }) =>
    stamp === null ? [] : [stamp],
  );
  const [counter] = await testDb
    .select({ lastValue: documentCounters.lastValue })
    .from(documentCounters)
    .where(eq(documentCounters.workspaceId, matter));
  const [ledger] = await testDb
    .select({ lastValue: documentReferenceCounters.lastValue })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, reference),
      ),
    );
  expect(entitiesWritten).toHaveLength(entityIds.length);
  expect(stamps.length).toBeGreaterThanOrEqual(entityIds.length);
  expect(stamps.every((stamp) => stamp.startsWith(`${reference}/`))).toBe(true);
  expect(new Set(stamps).size).toBe(stamps.length);
  expect(counter?.lastValue ?? null).toBe(expectedCounterValue);
  expect(ledger?.lastValue).toBe(expectedLastValue);
  expect(
    Math.max(
      0,
      ...entitiesWritten.flatMap(({ docSequence }) =>
        docSequence === null ? [] : [docSequence],
      ),
    ),
  ).toBeLessThanOrEqual(expectedLastValue);
};

beforeAll(async () => {
  fake = startFakeS3();
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  const rows = await testDb
    .select({
      matterNumberPattern: organizationSettings.matterNumberPattern,
      matterNumberPadding: organizationSettings.matterNumberPadding,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, ids.orgA));
  originalNumberingSettings = rows.at(0);
  if (originalNumberingSettings === undefined) {
    panic("Numbering test organization has no settings");
  }
});

afterAll(async () => {
  try {
    if (createdWorkspaceIds.length > 0) {
      await testDb
        .delete(workspaces)
        .where(inArray(workspaces.id, createdWorkspaceIds));
    }
    if (testReferences.length > 0) {
      await testDb
        .delete(documentReferenceCounters)
        .where(
          and(
            eq(documentReferenceCounters.organizationId, ids.orgA),
            inArray(documentReferenceCounters.reference, testReferences),
          ),
        );
    }
  } finally {
    try {
      if (originalNumberingSettings !== undefined) {
        await testDb
          .update(organizationSettings)
          .set(originalNumberingSettings)
          .where(eq(organizationSettings.organizationId, ids.orgA));
      }
    } finally {
      fake.stop();
      await releaseTestDb();
    }
  }
});

describe("numbering paths preserve issued stamps across counter state", () => {
  test.each(cases.map((scenario, index) => ({ scenario, index })))(
    "real numbering paths: %j",
    async ({ scenario, index }) => {
      const createdState = await seedMatterState(
        scenario,
        `PATH-${index}-CREATE/26`,
      );
      const created = expectOk(
        await Result.gen(() =>
          createEntitiesHandler({
            safeDb: scopeFor(createdState.matter),
            workspaceId: createdState.matter,
            userId: ids.userA1,
            recordAuditEvent,
            body: { name: "New document" },
          }),
        ),
      );
      await assertMatterIssuance({
        entityIds: [created.entityId],
        expectedLastValue: expectedInitialFloor(scenario) + 1,
        matter: createdState.matter,
        reference: `PATH-${index}-CREATE/26`,
      });

      const clipReference = `PATH-${index}-CLIP/26`;
      const clippedState = await seedMatterState(scenario, clipReference);
      const clipped = await clipEntity.handler(
        asTestRaw<Parameters<typeof clipEntity.handler>[0]>({
          getActiveWorkspaceIds: async () => [clippedState.matter],
          getAccessibleWorkspaces: async () => [
            { id: clippedState.matter, status: "active" },
          ],
          getWorkspaceAccess: async () => ({
            id: clippedState.matter,
            status: "active",
          }),
          memberRole: sessionMemberRole("owner"),
          body: { title: "Clipped source", url: "https://example.test/source" },
          createAuditRecorder: () => recordAuditEvent,
          recordAuditEvent,
          request: new Request(
            `https://example.test/workspaces/${clippedState.matter}`,
          ),
          route: "/test/entities/clip",
          safeDb: scopeFor(clippedState.matter),
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          workspaceId: clippedState.matter,
        }),
      );
      if (!("entityId" in clipped)) {
        panic("Clipping did not return the created entity");
      }
      expect(typeof clipped.entityId).toBe("string");
      await assertMatterIssuance({
        entityIds: [clipped.entityId],
        expectedLastValue: expectedInitialFloor(scenario) + 1,
        matter: clippedState.matter,
        reference: clipReference,
      });

      const uploadReference = `PATH-${index}-UPLOAD/26`;
      const uploadState = await seedMatterState(scenario, uploadReference);
      const filePropertyId = await createFileProperty(uploadState.matter);
      const uploaded = await runNumberingUpload({
        testDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: uploadState.matter,
        propertyId: filePropertyId,
      });
      expect(uploaded.finalizedResult.type).toBe("entity_create");
      if (uploaded.finalizedResult.type !== "entity_create") {
        panic("Expected entity-create upload result");
      }
      await restoreMatterState({
        scenario,
        reference: uploadReference,
        ...uploadState,
      });
      const versioned = await runNumberingUpload({
        testDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: uploadState.matter,
        propertyId: filePropertyId,
        entityId: uploaded.finalizedResult.entityId,
      });
      expect(versioned.finalizedResult.type).toBe("entity_version");
      if (versioned.finalizedResult.type !== "entity_version") {
        panic("Expected entity-version upload result");
      }
      const [uploadedEntity] = await testDb
        .select({ id: entities.id, docSequence: entities.docSequence })
        .from(entities)
        .where(eq(entities.id, uploaded.finalizedResult.entityId));
      const uploadedVersions = await testDb
        .select({ stamp: entityVersions.stamp })
        .from(entityVersions)
        .where(eq(entityVersions.entityId, uploaded.finalizedResult.entityId));
      const uploadStamps = uploadedVersions.flatMap(({ stamp }) =>
        stamp === null ? [] : [stamp],
      );
      expect(new Set(uploadStamps).size).toBe(uploadStamps.length);
      expect(uploadStamps).toHaveLength(2);
      expect(uploadedEntity?.docSequence).toBe(
        expectedInitialFloor(scenario) + 1,
      );
      await assertMatterIssuance({
        entityIds: [uploaded.finalizedResult.entityId],
        expectedLastValue: expectedInitialFloor(scenario) + 1,
        expectedCounterValue: scenario.counter === "10" ? 10 : null,
        matter: uploadState.matter,
        reference: uploadReference,
      });

      const copyReference = `PATH-${index}-COPY/26`;
      const copyState = await seedMatterState(scenario, copyReference);
      const copySource = await createMatter(`PATH-${index}-COPY-SOURCE/26`);
      const copied = await runNumberingCopy({
        testDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
        sourceWorkspaceId: copySource,
        targetWorkspaceId: copyState.matter,
      });
      await assertMatterIssuance({
        entityIds: [copied.entityId],
        expectedLastValue: expectedInitialFloor(scenario) + 1,
        matter: copyState.matter,
        reference: copyReference,
      });

      const duplicateSourceReference = `PATH-${index}-DUP-SOURCE/26`;
      const duplicateState = await seedMatterState(
        scenario,
        duplicateSourceReference,
      );
      const duplicateSource = duplicateState.matter;
      const sourceEntity = expectOk(
        await Result.gen(() =>
          createEntitiesHandler({
            safeDb: scopeFor(duplicateSource),
            workspaceId: duplicateSource,
            userId: ids.userA1,
            recordAuditEvent,
            body: { name: "Source document" },
          }),
        ),
      );
      await restoreMatterState({
        scenario,
        reference: duplicateSourceReference,
        ...duplicateState,
      });
      const duplicatePattern = `PATH-${index}-DUP-{SEQ}`;
      const candidateReference = `PATH-${index}-DUP-001`;
      await testDb
        .update(organizationSettings)
        .set({ matterNumberPattern: duplicatePattern, matterNumberPadding: 3 })
        .where(eq(organizationSettings.organizationId, ids.orgA));
      await testDb
        .delete(matterCounters)
        .where(
          and(
            eq(matterCounters.organizationId, ids.orgA),
            eq(
              matterCounters.scopeKey,
              toScopeKey(duplicatePattern, new Date()),
            ),
          ),
        );
      testReferences.push(candidateReference);
      if (scenario.ledger === "present") {
        const duplicateOwner =
          scenario.owner === "other"
            ? await createMatter(`PATH-${index}-DUP-OTHER/26`)
            : duplicateSource;
        await testDb.insert(documentReferenceCounters).values({
          id: createSafeId<"documentReferenceCounter">(),
          organizationId: ids.orgA,
          reference: candidateReference,
          workspaceId: scenario.owner === "null" ? null : duplicateOwner,
          lastValue: scenario.lastValue,
        });
      }
      const duplicate = await duplicateWorkspace.handler(
        asTestRaw<Parameters<typeof duplicateWorkspace.handler>[0]>({
          body: { includeContent: true },
          safeDb: scopeFor(duplicateSource),
          scopedDb: createScopedDb(
            testDb,
            [duplicateSource],
            ids.orgA,
            ids.userA1,
          ),
          memberRole: sessionMemberRole("owner"),
          orgAIConfig: null,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
          managedAIResidency: "eu" as const,
          request: new Request(
            `https://example.test/workspaces/${duplicateSource}/duplicate`,
          ),
          route: "/test/workspaces/duplicate",
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          workspaceId: duplicateSource,
          recordAuditEvent,
          createAuditRecorder: () => recordAuditEvent,
        }),
      );
      if (
        !("workspaceId" in duplicate) ||
        typeof duplicate.workspaceId !== "string"
      ) {
        panic("Matter duplication did not return the new matter ID");
      }
      const duplicateMatterId = duplicate.workspaceId;
      createdWorkspaceIds.push(duplicateMatterId);
      const [duplicateMatter] = await testDb
        .select({ reference: workspaces.reference })
        .from(workspaces)
        .where(eq(workspaces.id, duplicateMatterId));
      if (!duplicateMatter?.reference) {
        panic("Duplicated matter has no reference");
      }
      const duplicateReference = duplicateMatter.reference;
      expect(duplicateReference).toBe(
        scenario.ledger === "present"
          ? `PATH-${index}-DUP-002`
          : candidateReference,
      );
      const [candidateLedger] = await testDb
        .select({ lastValue: documentReferenceCounters.lastValue })
        .from(documentReferenceCounters)
        .where(
          and(
            eq(documentReferenceCounters.organizationId, ids.orgA),
            eq(documentReferenceCounters.reference, candidateReference),
          ),
        );
      expect(candidateLedger?.lastValue).toBe(
        scenario.ledger === "present" ? scenario.lastValue : 1,
      );
      const duplicateEntities = await testDb
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.workspaceId, duplicateMatterId));
      const duplicateStamps = await testDb
        .select({ stamp: entityVersions.stamp })
        .from(entityVersions)
        .where(
          inArray(
            entityVersions.entityId,
            duplicateEntities.map(({ id }) => id),
          ),
        );
      const newDuplicateStamps = duplicateStamps.flatMap(({ stamp }) =>
        stamp?.startsWith(`${duplicateReference}/`) ? [stamp] : [],
      );
      expect(duplicateEntities.length).toBeGreaterThan(0);
      expect(new Set(newDuplicateStamps).size).toBe(newDuplicateStamps.length);
      expect(newDuplicateStamps).toEqual([`${duplicateReference}/001.v1`]);
      const [destinationLedger] = await testDb
        .select({ lastValue: documentReferenceCounters.lastValue })
        .from(documentReferenceCounters)
        .where(
          and(
            eq(documentReferenceCounters.organizationId, ids.orgA),
            eq(documentReferenceCounters.reference, duplicateReference),
          ),
        );
      expect(destinationLedger?.lastValue).toBe(
        Math.max(
          0,
          ...newDuplicateStamps.map((stamp) =>
            Number(/\/(\d+)\.v/u.exec(stamp)?.[1] ?? 0),
          ),
        ),
      );
      expect(sourceEntity.entityId).toBeTruthy();
      testReferences.push(duplicateReference);
    },
  );
});

test("matter creation skips an already numbered reference candidate", async () => {
  const pattern = "PATH-CREATE-SKIP-{SEQ}";
  const candidate = "PATH-CREATE-SKIP-001";
  testReferences.push(candidate);
  await testDb
    .update(organizationSettings)
    .set({ matterNumberPattern: pattern, matterNumberPadding: 3 })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await testDb.insert(documentReferenceCounters).values({
    id: createSafeId<"documentReferenceCounter">(),
    organizationId: ids.orgA,
    reference: candidate,
    workspaceId: null,
    lastValue: 5,
  });

  const workspaceId = createSafeId<"workspace">();
  const created = expectOk(
    await Result.gen(() =>
      createWorkspaceHandler({
        userEmail: "standard@example.test",
        safeDb: asTestRaw(createSafeDb(testDb, [], ids.orgA, ids.userA1)),
        organizationId: ids.orgA,
        userId: ids.userA1,
        recordAuditEvent,
        body: {
          id: workspaceId,
          name: "Matter numbering integration",
          filePropertyName: "Documents",
        },
      }),
    ),
  );
  createdWorkspaceIds.push(created.id);
  const [workspace] = await testDb
    .select({ reference: workspaces.reference })
    .from(workspaces)
    .where(eq(workspaces.id, created.id));
  expect(workspace?.reference).toBe("PATH-CREATE-SKIP-002");
  const [ledger] = await testDb
    .select({ lastValue: documentReferenceCounters.lastValue })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, ids.orgA),
        eq(documentReferenceCounters.reference, candidate),
      ),
    );
  expect(ledger?.lastValue).toBe(5);
});

test("every full stamp issued in the organization is unique", async () => {
  const versions = await testDb
    .select({ stamp: entityVersions.stamp })
    .from(entityVersions)
    .where(inArray(entityVersions.workspaceId, createdWorkspaceIds));
  const stamps = versions.flatMap(({ stamp }) =>
    stamp === null ? [] : [stamp],
  );
  expect(stamps.length).toBeGreaterThan(0);
  expect(new Set(stamps).size).toBe(stamps.length);
});

test.each([
  MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS - 1,
  MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS,
])(
  "matter allocation is bounded with %d unavailable candidates",
  async (blockedCount) => {
    const pattern = `PATH-BOUND-${blockedCount}-{SEQ}`;
    const references = Array.from(
      { length: blockedCount },
      (_, index) =>
        `PATH-BOUND-${blockedCount}-${String(index + 1).padStart(3, "0")}`,
    );
    testReferences.push(...references);
    await testDb
      .update(organizationSettings)
      .set({ matterNumberPattern: pattern, matterNumberPadding: 3 })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    await testDb.insert(documentReferenceCounters).values(
      references.map((reference) => ({
        id: createSafeId<"documentReferenceCounter">(),
        organizationId: ids.orgA,
        reference,
        workspaceId: null,
        lastValue: 5,
      })),
    );
    const workspaceId = createSafeId<"workspace">();
    createdWorkspaceIds.push(workspaceId);
    const create = async () =>
      await Result.gen(() =>
        createWorkspaceHandler({
          userEmail: "standard@example.test",
          safeDb: asTestRaw(createSafeDb(testDb, [], ids.orgA, ids.userA1)),
          organizationId: ids.orgA,
          userId: ids.userA1,
          recordAuditEvent,
          body: {
            id: workspaceId,
            name: "Bounded numbering",
            filePropertyName: "Documents",
          },
        }),
      );
    const result = await create();
    let expectedReference = `PATH-BOUND-${blockedCount}-${String(blockedCount + 1).padStart(3, "0")}`;
    if (blockedCount === MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS) {
      expect(Result.isError(result)).toBe(true);
      if (Result.isOk(result)) {
        panic("Exhausted allocation unexpectedly succeeded");
      }
      expect(HandlerError.is(result.error)).toBe(true);
      if (!HandlerError.is(result.error)) {
        panic("Exhausted allocation did not return a recoverable error");
      }
      expect(result.error.status).toBe(409);
      expect(result.error.code).toBe("MATTER_REFERENCE_ALLOCATION_EXHAUSTED");
      const counters = await testDb
        .select()
        .from(matterCounters)
        .where(
          and(
            eq(matterCounters.organizationId, ids.orgA),
            eq(matterCounters.scopeKey, toScopeKey(pattern, new Date())),
          ),
        );
      expect(counters).toHaveLength(0);
      const matters = await testDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      expect(matters).toHaveLength(0);
      expectedReference = `PATH-BOUND-${blockedCount}-001`;
      await testDb
        .delete(documentReferenceCounters)
        .where(
          and(
            eq(documentReferenceCounters.organizationId, ids.orgA),
            eq(documentReferenceCounters.reference, expectedReference),
          ),
        );
      expectOk(await create());
    } else {
      expectOk(result);
    }
    const rows = await testDb
      .select({ reference: workspaces.reference })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(rows.at(0)?.reference).toBe(expectedReference);
    const counters = await testDb
      .select({ lastValue: matterCounters.lastValue })
      .from(matterCounters)
      .where(
        and(
          eq(matterCounters.organizationId, ids.orgA),
          eq(matterCounters.scopeKey, toScopeKey(pattern, new Date())),
        ),
      );
    expect(counters.at(0)?.lastValue).toBe(
      blockedCount === MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS
        ? 1
        : blockedCount + 1,
    );
  },
);
