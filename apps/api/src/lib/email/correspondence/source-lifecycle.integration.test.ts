import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";

import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondenceSources,
  entities,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { parseDataBoxMessage } from "@/api/lib/email/correspondence/data-box/zfo";
import { zfoFile } from "@/api/tests/fixtures/zfo";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(releaseRlsFixture);

type ExecutableTransaction = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

type ReadOtherSourcesOptions = {
  tx: ExecutableTransaction;
  workspaceId: SafeId<"workspace">;
  sourceEntityId: SafeId<"entity">;
};

const readOtherSources = async ({
  tx,
  workspaceId,
  sourceEntityId,
}: ReadOtherSourcesOptions) => {
  const rows = executedRows(
    await tx.execute(sql`
      SELECT public.correspondence_has_other_sources(${workspaceId}, ${sourceEntityId}) AS has_other_sources
    `),
  );
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows.at(0) ?? {})).toEqual(["has_other_sources"]);
  return v.parse(
    v.object({ has_other_sources: v.nullable(v.boolean()) }),
    rows.at(0),
  ).has_other_sources;
};

const sourceMessage = async (sourceEntityId: SafeId<"entity">) => {
  const decoded = parseDataBoxMessage(await zfoFile());
  if (decoded.isErr()) {
    throw decoded.error;
  }
  const { envelope } = decoded.value;
  return {
    source: "upload",
    channel: "data_box",
    sourceEntityId,
    originalSignature: { status: "unverified" },
    contentHash: "a".repeat(64),
    from: { address: envelope.sender.boxId, name: envelope.sender.name },
    to: [{ address: envelope.recipient.boxId, name: envelope.recipient.name }],
    cc: [],
    subject: "Shared message",
    sentAt: null,
    receivedAt: "2026-10-29T00:00:00.000Z",
    inReplyTo: null,
    references: [],
    bodyText: "Message body",
    bodyHtml: null,
    direction: null,
    messageId: envelope.messageId,
    dataBox: envelope,
  } satisfies ParsedCorrespondence;
};

test("source lifetime lookup respects feature visibility and tenant scope", async () => {
  const workspaceId = createSafeId<"workspace">();
  const firstEntityId = createSafeId<"entity">();
  const hiddenEntityId = createSafeId<"entity">();
  const unadmittedEntityId = createSafeId<"entity">();
  const { orgA: organizationId, userA1: userId, orgB, userB1 } = ids;
  const db = markRlsDatabase(testDb);
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Personal source matter",
    reference: `SOURCE-${workspaceId}`,
  });
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await testDb.insert(entities).values(
    [firstEntityId, hiddenEntityId, unadmittedEntityId].map((id) => ({
      id,
      workspaceId,
      name: "Correspondence source",
      createdBy: userId,
    })),
  );

  const parsed = await sourceMessage(firstEntityId);
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId], organizationId, userId),
  );
  const recordAuditEvent = createAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://api.example.test/v1/correspondence"),
    server: null,
  });
  const correspondenceIds: SafeId<"correspondence">[] = [];
  for (const sourceEntityId of [firstEntityId, hiddenEntityId]) {
    const result = await createCorrespondence({
      safeDb,
      organizationId,
      workspaceId,
      filer: { type: "user", userId },
      parsed: { ...parsed, sourceEntityId },
      expectedSourceVersionId: null,
      attachments: [],
      recordAuditEvent,
    });
    if (result.type !== "ok") {
      throw result.type === "error"
        ? result.error
        : new Error(`Correspondence filing returned ${result.type}`);
    }
    correspondenceIds.push(result.id);
  }
  const [firstCorrespondenceId, secondCorrespondenceId] = correspondenceIds;
  if (
    firstCorrespondenceId === undefined ||
    secondCorrespondenceId === undefined
  ) {
    throw new Error("Expected both correspondence copies to be filed");
  }
  expect(firstCorrespondenceId).toBe(secondCorrespondenceId);
  await testDb
    .update(entities)
    .set({ kind: "task", listItemType: "fact" })
    .where(eq(entities.id, hiddenEntityId));

  await createScopedDb(
    db,
    [workspaceId],
    organizationId,
    userId,
  )(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.enabled_features', '[]', true)`,
    );
    const visibleSources = await tx
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, firstCorrespondenceId));
    expect(visibleSources.map(({ entityId }) => entityId)).toEqual([
      firstEntityId,
    ]);

    await tx.execute(sql`SELECT
      set_config('app.correspondence_source_organization_id', 'restore-org', true),
      set_config('app.correspondence_source_workspace_id', 'restore-workspace', true),
      set_config('app.correspondence_source_record_id', '00000000-0000-0000-0000-000000000001', true),
      set_config('app.correspondence_source_entity_id', '00000000-0000-0000-0000-000000000002', true)`);
    expect(
      await readOtherSources({
        tx,
        workspaceId,
        sourceEntityId: firstEntityId,
      }),
    ).toBe(true);
    expect(
      await readOtherSources({
        tx,
        workspaceId,
        sourceEntityId: hiddenEntityId,
      }),
    ).toBeNull();
    expect(
      await readOtherSources({
        tx,
        workspaceId,
        sourceEntityId: unadmittedEntityId,
      }),
    ).toBeNull();
    expect(
      await tx
        .select({ entityId: correspondenceSources.entityId })
        .from(correspondenceSources)
        .where(
          eq(correspondenceSources.correspondenceId, firstCorrespondenceId),
        ),
    ).toEqual(visibleSources);
    expect(
      await tx
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.id, hiddenEntityId)),
    ).toEqual([]);
    const restored = executedRows(
      await tx.execute(sql`SELECT
      current_setting('app.correspondence_source_organization_id', true) AS organization_id,
      current_setting('app.correspondence_source_workspace_id', true) AS workspace_id,
      current_setting('app.correspondence_source_record_id', true) AS record_id,
      current_setting('app.correspondence_source_entity_id', true) AS entity_id`),
    );
    expect(restored).toEqual([
      {
        organization_id: "restore-org",
        workspace_id: "restore-workspace",
        record_id: "00000000-0000-0000-0000-000000000001",
        entity_id: "00000000-0000-0000-0000-000000000002",
      },
    ]);
  });

  await createScopedDb(
    db,
    [],
    orgB,
    userB1,
  )(async (tx) => {
    expect(
      await readOtherSources({
        tx,
        workspaceId,
        sourceEntityId: firstEntityId,
      }),
    ).toBeNull();
  });
  await testDb
    .update(workspaces)
    .set({ status: "archived" })
    .where(eq(workspaces.id, workspaceId));
  await createScopedDb(
    db,
    [workspaceId],
    organizationId,
    userId,
  )(async (tx) => {
    expect(
      await readOtherSources({
        tx,
        workspaceId,
        sourceEntityId: firstEntityId,
      }),
    ).toBeNull();
  });
});
