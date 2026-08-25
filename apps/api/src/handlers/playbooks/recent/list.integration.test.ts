import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { documentReviewRuns, playbookDefinitions } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { listRecentPlaybooksHandler } from "@/api/handlers/playbooks/recent/list";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const definitionIds: SafeId<"playbookDefinition">[] = [];
const runIds: SafeId<"documentReviewRun">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  try {
    if (runIds.length > 0) {
      await testDb
        .delete(documentReviewRuns)
        .where(inArray(documentReviewRuns.id, runIds));
    }
    if (definitionIds.length > 0) {
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, definitionIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const seedDefinition = async (
  organizationId: SafeId<"organization">,
  name: string,
): Promise<SafeId<"playbookDefinition">> => {
  const id = toSafeId<"playbookDefinition">(Bun.randomUUIDv7());
  definitionIds.push(id);
  await testDb.execute(sql`
    INSERT INTO playbook_definitions (
      id, organization_id, name, positions
    ) VALUES (
      ${id}, ${organizationId}, ${name}, '{"version":2,"items":[]}'::jsonb
    )
  `);
  return id;
};

type SeedRunOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  playbookDefinitionId: SafeId<"playbookDefinition"> | null;
  createdAt: string;
};

const seedRun = async ({
  organizationId,
  workspaceId,
  userId,
  playbookDefinitionId,
  createdAt,
}: SeedRunOptions): Promise<void> => {
  const id = toSafeId<"documentReviewRun">(Bun.randomUUIDv7());
  runIds.push(id);
  await testDb.execute(sql`
    INSERT INTO document_review_runs (
      id, organization_id, workspace_id, entity_id, file_field_id,
      entity_version_id, content_sha256, playbook_definition_id, basis,
      status, requested_by, created_at
    ) VALUES (
      ${id},
      ${organizationId},
      ${workspaceId},
      ${Bun.randomUUIDv7()}::uuid,
      ${Bun.randomUUIDv7()}::uuid,
      ${Bun.randomUUIDv7()}::uuid,
      ${"a".repeat(64)},
      ${playbookDefinitionId}::uuid,
      '{"playbook":{"definitionId":null,"versionId":null,"provenance":"ephemeral","definitionSnapshot":{"name":"Positions confirmed for this review","positions":{"version":3,"items":[]}}},"references":[],"perspective":{"type":"neutral"}}'::jsonb,
      'completed',
      ${userId},
      ${createdAt}::timestamptz
    )
  `);
};

describe("recent playbooks", () => {
  test("deduplicates current-user usage and excludes other users, organizations, and deleted definitions", async () => {
    const newest = await seedDefinition(ids.orgA, "Newest");
    const older = await seedDefinition(ids.orgA, "Older");
    const otherUser = await seedDefinition(ids.orgA, "Other user");
    const deleted = await seedDefinition(ids.orgA, "Deleted");
    const otherOrganization = await seedDefinition(ids.orgB, "Other org");

    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      playbookDefinitionId: newest,
      createdAt: "2026-08-13T09:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      playbookDefinitionId: older,
      createdAt: "2026-08-13T10:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      playbookDefinitionId: newest,
      createdAt: "2026-08-13T11:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA2,
      playbookDefinitionId: otherUser,
      createdAt: "2026-08-13T12:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
      playbookDefinitionId: otherOrganization,
      createdAt: "2026-08-13T13:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      playbookDefinitionId: deleted,
      createdAt: "2026-08-13T14:00:00.000Z",
    });
    await seedRun({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      playbookDefinitionId: null,
      createdAt: "2026-08-13T15:00:00.000Z",
    });

    await testDb
      .delete(playbookDefinitions)
      .where(sql`${playbookDefinitions.id} = ${deleted}`);

    const result = await Result.gen(() =>
      listRecentPlaybooksHandler({
        safeDb,
        organizationId: ids.orgA,
        userId: ids.userA1,
      }),
    );

    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.items.map(({ id }) => id)).toEqual([newest, older]);
    expect(result.value.items.at(0)?.lastUsedAt).toBe(
      "2026-08-13T11:00:00.000Z",
    );
    expect(result.value.nextCursor).toBeNull();
    expect(result.value.limit).toBe(4);
  });
});
