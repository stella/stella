import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  correspondenceSources,
  entities,
  entityVersions,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  createCorrespondence,
  retireCorrespondenceSource,
} from "@/api/lib/email/correspondence/create";
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

type FileCopyOptions = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  parsed: Extract<ParsedCorrespondence, { source: "upload" }>;
  attachmentId: SafeId<"entity">;
  expectedSourceVersionId?: SafeId<"entityVersion"> | null;
};

const fileCopy = async ({
  workspaceId,
  entityId,
  parsed,
  attachmentId,
  expectedSourceVersionId,
}: FileCopyOptions) => {
  const source = await testDb
    .select({ currentVersionId: entities.currentVersionId })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const result = await createCorrespondence({
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], ids.orgA, ids.userA1),
    ),
    organizationId: ids.orgA,
    workspaceId,
    filer: { type: "user", userId: ids.userA1 },
    parsed: { ...parsed, sourceEntityId: entityId },
    expectedSourceVersionId:
      expectedSourceVersionId === undefined
        ? (source.at(0)?.currentVersionId ?? null)
        : expectedSourceVersionId,
    attachments: [
      {
        entityId: attachmentId,
        filename: "evidence.pdf",
        mediaType: "application/pdf",
        byteSize: 128,
        scanVerdict: "clean",
      },
    ],
    recordAuditEvent: createAuditRecorder({
      organizationId: ids.orgA,
      workspaceId,
      userId: ids.userA1,
      request: new Request("https://api.example.test/v1/correspondence"),
      server: null,
    }),
  });
  if (result.type === "error") {
    throw result.error;
  }
  if (result.type !== "ok") {
    throw new Error(`Expected filing success, received ${result.type}`);
  }
  return result;
};

test("data-box correspondence lives until its last matter source is deleted", async () => {
  const decoded = parseDataBoxMessage(await zfoFile());
  if (decoded.isErr()) {
    throw decoded.error;
  }
  const { envelope, annotation } = decoded.value;
  const firstSource = createSafeId<"entity">();
  const secondSource = createSafeId<"entity">();
  const otherMatterSource = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  const otherAttachmentId = createSafeId<"entity">();
  await testDb.insert(entities).values([
    ...[firstSource, secondSource, attachmentId].map((id) => ({
      id,
      workspaceId: ids.wsA1,
      name: "Source fixture",
      createdBy: ids.userA1,
    })),
    ...[otherMatterSource, otherAttachmentId].map((id) => ({
      id,
      workspaceId: ids.wsA2,
      name: "Other matter fixture",
      createdBy: ids.userA1,
    })),
  ]);
  const parsed = {
    channel: "data_box",
    source: "upload",
    sourceEntityId: firstSource,
    originalSignature: { status: "unverified" },
    dataBox: envelope,
    direction: null,
    messageId: envelope.messageId,
    contentHash: "c".repeat(64),
    from: { address: envelope.sender.boxId, name: envelope.sender.name },
    to: [{ address: envelope.recipient.boxId, name: envelope.recipient.name }],
    cc: [],
    subject: annotation,
    sentAt: null,
    receivedAt: "2026-10-14T07:12:33.120Z",
    inReplyTo: null,
    references: [],
    bodyText: "",
    bodyHtml: null,
  } satisfies ParsedCorrespondence;
  const options = { workspaceId: ids.wsA1, parsed, attachmentId };
  const first = await fileCopy({ ...options, entityId: firstSource });
  const second = await fileCopy({ ...options, entityId: secondSource });
  const replay = await fileCopy({ ...options, entityId: secondSource });
  const other = await fileCopy({
    workspaceId: ids.wsA2,
    entityId: otherMatterSource,
    parsed,
    attachmentId: otherAttachmentId,
  });
  expect(second.id).toBe(first.id);
  expect(replay.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);

  const sources = () =>
    testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, first.id))
      .orderBy(asc(correspondenceSources.entityId));
  expect(await sources()).toEqual(
    [firstSource, secondSource].toSorted().map((entityId) => ({ entityId })),
  );
  const filers = () =>
    testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, first.id));
  const attachments = () =>
    testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, first.id));
  const initialFilers = await filers();
  const initialAttachments = await attachments();
  expect(initialFilers).toHaveLength(1);
  expect(initialAttachments).toHaveLength(1);

  expect(
    await rejectionOf(
      testDb
        .insert(correspondenceSources)
        .values({
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          correspondenceId: first.id,
          entityId: otherAttachmentId,
        })
        .execute(),
    ),
  ).toMatchObject({
    cause: { constraint: "correspondence_sources_entity_workspace_fk" },
  });

  const foreignSafeDb = createSafeDb(testDb, [ids.wsB1], ids.orgB, ids.userB1);
  const foreignRead = await foreignSafeDb(
    async (tx) =>
      await tx
        .select()
        .from(correspondenceSources)
        .where(eq(correspondenceSources.correspondenceId, first.id)),
  );
  expect(foreignRead.isOk() && foreignRead.value).toEqual([]);
  const foreignWrite = await foreignSafeDb(
    async (tx) =>
      await tx.insert(correspondenceSources).values({
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        correspondenceId: first.id,
        entityId: attachmentId,
      }),
  );
  expect(foreignWrite.isErr() && foreignWrite.error._tag).toBe(
    "DatabaseRlsError",
  );

  const deleteSource = async (sourceId: SafeId<"entity">) => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT
        set_config('app.correspondence_source_organization_id', ${ids.orgB}, true),
        set_config('app.correspondence_source_workspace_id', ${ids.wsB1}, true),
        set_config('app.correspondence_source_record_id', ${other.id}, true),
        set_config('app.correspondence_source_entity_id', ${otherMatterSource}, true)
      `);
      const scope = sql`SELECT
        current_setting('app.correspondence_source_organization_id', true) AS organization_id,
        current_setting('app.correspondence_source_workspace_id', true) AS workspace_id,
        current_setting('app.correspondence_source_record_id', true) AS record_id,
        current_setting('app.correspondence_source_entity_id', true) AS entity_id
      `;
      const before = await tx.execute(scope);
      await tx.delete(entities).where(eq(entities.id, sourceId));
      const after = await tx.execute(scope);
      expect(after.rows).toEqual(before.rows);
    });
  };
  await deleteSource(firstSource);
  expect(await sources()).toEqual([{ entityId: secondSource }]);
  expect(
    await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, first.id)),
  ).toEqual([{ sourceEntityId: secondSource }]);
  expect(await filers()).toEqual(initialFilers);
  expect(await attachments()).toEqual(initialAttachments);

  await deleteSource(secondSource);
  expect(await sources()).toEqual([]);
  expect(
    await testDb
      .select()
      .from(correspondence)
      .where(eq(correspondence.id, first.id)),
  ).toEqual([]);
  expect(await filers()).toEqual([]);
  expect(await attachments()).toEqual([]);
  expect(
    await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, other.id)),
  ).toEqual([{ sourceEntityId: otherMatterSource }]);
  expect(
    await testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, other.id)),
  ).toEqual([{ entityId: otherMatterSource }]);
});

test("uploaded email correspondence is removed with its source entity", async () => {
  const entityId = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  const secondSourceId = createSafeId<"entity">();
  await testDb.insert(entities).values(
    [entityId, attachmentId, secondSourceId].map((id) => ({
      id,
      workspaceId: ids.wsA1,
      name: "Email lifetime fixture",
      createdBy: ids.userA1,
    })),
  );
  const parsed = {
    channel: "email",
    dataBox: null,
    source: "upload",
    sourceEntityId: entityId,
    originalSignature: { status: "unverified" },
    direction: "in",
    messageId: `<${Bun.randomUUIDv7()}@example.test>`,
    contentHash: "d".repeat(64),
    from: { address: "sender@example.test", name: null },
    to: [],
    cc: [],
    subject: "Uploaded email",
    sentAt: null,
    receivedAt: "2026-10-14T07:12:33.120Z",
    inReplyTo: null,
    references: [],
    bodyText: "Email body",
    bodyHtml: null,
  } satisfies ParsedCorrespondence;
  const record = await fileCopy({
    workspaceId: ids.wsA1,
    entityId,
    parsed,
    attachmentId,
  });
  const secondRecord = await fileCopy({
    workspaceId: ids.wsA1,
    entityId: secondSourceId,
    parsed,
    attachmentId,
  });
  expect(secondRecord.id).not.toBe(record.id);
  expect(
    await testDb
      .select()
      .from(correspondence)
      .where(eq(correspondence.id, record.id)),
  ).toHaveLength(1);
  expect(
    await testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, record.id)),
  ).toEqual([{ entityId }]);
  await testDb.delete(entities).where(eq(entities.id, entityId));
  expect(
    await testDb
      .select()
      .from(correspondence)
      .where(eq(correspondence.id, record.id)),
  ).toEqual([]);
  expect(
    await testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, record.id)),
  ).toEqual([]);
  expect(
    await testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, record.id)),
  ).toEqual([]);
  expect(
    await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, secondRecord.id)),
  ).toEqual([{ sourceEntityId: secondSourceId }]);
  expect(
    await testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, secondRecord.id)),
  ).toEqual([{ entityId: secondSourceId }]);
});

type ParsedDataBoxFixtureOptions = {
  entityId: SafeId<"entity">;
  messageId: string;
};

const parsedDataBoxFixture = async ({
  entityId,
  messageId,
}: ParsedDataBoxFixtureOptions) => {
  const decoded = parseDataBoxMessage(await zfoFile({ messageId }));
  if (decoded.isErr()) {
    throw decoded.error;
  }
  const { envelope, annotation } = decoded.value;
  return {
    channel: "data_box",
    source: "upload",
    sourceEntityId: entityId,
    originalSignature: { status: "unverified" },
    dataBox: envelope,
    direction: null,
    messageId: envelope.messageId,
    contentHash: "e".repeat(64),
    from: { address: envelope.sender.boxId, name: envelope.sender.name },
    to: [{ address: envelope.recipient.boxId, name: envelope.recipient.name }],
    cc: [],
    subject: annotation,
    sentAt: null,
    receivedAt: "2026-10-14T07:12:33.120Z",
    inReplyTo: null,
    references: [],
    bodyText: "",
    bodyHtml: null,
  } satisfies ParsedCorrespondence;
};

test("correspondence retains its remaining source across feature visibility changes", async () => {
  const firstSource = createSafeId<"entity">();
  const remainingSource = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  await testDb.insert(entities).values([
    {
      id: firstSource,
      workspaceId: ids.wsA1,
      name: "Primary source",
      createdBy: ids.userA1,
    },
    {
      id: remainingSource,
      workspaceId: ids.wsA1,
      name: "Remaining source",
      createdBy: ids.userA1,
    },
    {
      id: attachmentId,
      workspaceId: ids.wsA1,
      name: "Message attachment",
      createdBy: ids.userA1,
    },
  ]);
  const parsed = await parsedDataBoxFixture({
    entityId: firstSource,
    messageId: "95000000001",
  });
  const filed = await fileCopy({
    workspaceId: ids.wsA1,
    entityId: firstSource,
    parsed,
    attachmentId,
  });
  const duplicate = await fileCopy({
    workspaceId: ids.wsA1,
    entityId: remainingSource,
    parsed,
    attachmentId,
  });
  expect(duplicate.id).toBe(filed.id);
  await testDb
    .update(entities)
    .set({ kind: "task", listItemType: "fact" })
    .where(eq(entities.id, remainingSource));
  expect(
    await testDb
      .select({ gate: correspondenceSources.entityFeatureGate })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.entityId, remainingSource)),
  ).toEqual([{ gate: "legal-lists" }]);
  await createScopedDb(
    testDb,
    [ids.wsA1],
    ids.orgA,
    ids.userA1,
  )(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.enabled_features', '[]', true)`,
    );
    expect(
      await tx
        .select({ id: correspondenceSources.entityId })
        .from(correspondenceSources)
        .where(eq(correspondenceSources.correspondenceId, filed.id)),
    ).toEqual([{ id: firstSource }]);
    await tx.delete(entities).where(eq(entities.id, firstSource));
  });
  expect(
    await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, filed.id)),
  ).toEqual([{ sourceEntityId: remainingSource }]);
  expect(
    await testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, filed.id)),
  ).toEqual([{ entityId: remainingSource }]);
});

const replacementScenarios = [
  {
    oldSources: "last",
    target: "new",
    oldMessageId: "91000000001",
    newMessageId: "91000000002",
  },
  {
    oldSources: "copy",
    target: "new",
    oldMessageId: "91000000003",
    newMessageId: "91000000004",
  },
  {
    oldSources: "last",
    target: "existing",
    oldMessageId: "91000000005",
    newMessageId: "91000000006",
  },
  {
    oldSources: "copy",
    target: "existing",
    oldMessageId: "91000000007",
    newMessageId: "91000000008",
  },
] as const;

test.each(replacementScenarios)(
  "a new source version replaces its message with $oldSources old source and $target target",
  async (scenario) => {
    const sourceId = createSafeId<"entity">();
    const retainedSourceId = createSafeId<"entity">();
    const targetSourceId = createSafeId<"entity">();
    const oldAttachmentId = createSafeId<"entity">();
    const targetAttachmentId = createSafeId<"entity">();
    const replacementAttachmentId = createSafeId<"entity">();
    await testDb.insert(entities).values(
      [
        sourceId,
        retainedSourceId,
        targetSourceId,
        oldAttachmentId,
        targetAttachmentId,
        replacementAttachmentId,
      ].map((id) => ({
        id,
        workspaceId: ids.wsA1,
        name: "Version replacement fixture",
        createdBy: ids.userA1,
      })),
    );
    const firstVersionId = createSafeId<"entityVersion">();
    const secondVersionId = createSafeId<"entityVersion">();
    await testDb.insert(entityVersions).values({
      id: firstVersionId,
      workspaceId: ids.wsA1,
      entityId: sourceId,
      versionNumber: 1,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: firstVersionId })
      .where(eq(entities.id, sourceId));
    const oldParsed = await parsedDataBoxFixture({
      entityId: sourceId,
      messageId: scenario.oldMessageId,
    });
    const oldOptions = {
      workspaceId: ids.wsA1,
      parsed: oldParsed,
      attachmentId: oldAttachmentId,
    };
    const old = await fileCopy({ ...oldOptions, entityId: sourceId });
    if (scenario.oldSources === "copy") {
      expect(
        (await fileCopy({ ...oldOptions, entityId: retainedSourceId })).id,
      ).toBe(old.id);
    }
    const oldFilers = await testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, old.id));
    const oldAttachments = await testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, old.id));
    expect(oldFilers).toHaveLength(1);
    expect(oldAttachments).toHaveLength(1);
    const newParsed = await parsedDataBoxFixture({
      entityId: sourceId,
      messageId: scenario.newMessageId,
    });
    const existingTarget =
      scenario.target === "existing"
        ? await fileCopy({
            workspaceId: ids.wsA1,
            parsed: newParsed,
            entityId: targetSourceId,
            attachmentId: targetAttachmentId,
          })
        : null;
    await testDb.insert(entityVersions).values({
      id: secondVersionId,
      workspaceId: ids.wsA1,
      entityId: sourceId,
      versionNumber: 2,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: secondVersionId })
      .where(eq(entities.id, sourceId));
    const replacementOptions = {
      workspaceId: ids.wsA1,
      parsed: newParsed,
      entityId: sourceId,
      attachmentId: replacementAttachmentId,
    };
    const replacement = await fileCopy(replacementOptions);
    expect(replacement.id).not.toBe(old.id);
    if (existingTarget !== null) {
      expect(replacement.id).toBe(existingTarget.id);
    }
    expect(
      await testDb
        .select({ correspondenceId: correspondenceSources.correspondenceId })
        .from(correspondenceSources)
        .where(eq(correspondenceSources.entityId, sourceId)),
    ).toEqual([{ correspondenceId: replacement.id }]);
    const remainingOld = await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, old.id));
    const remainingOldSources = await testDb
      .select({ entityId: correspondenceSources.entityId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, old.id));
    const remainingOldFilers = await testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, old.id));
    const remainingOldAttachments = await testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, old.id));
    if (scenario.oldSources === "copy") {
      expect(remainingOld).toEqual([{ sourceEntityId: retainedSourceId }]);
      expect(remainingOldSources).toEqual([{ entityId: retainedSourceId }]);
      expect(remainingOldFilers).toEqual(oldFilers);
      expect(remainingOldAttachments).toEqual(oldAttachments);
    } else {
      expect(remainingOld).toEqual([]);
      expect(remainingOldSources).toEqual([]);
      expect(remainingOldFilers).toEqual([]);
      expect(remainingOldAttachments).toEqual([]);
    }
    const sourcesAfterReplacement = await testDb
      .select()
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, replacement.id))
      .orderBy(asc(correspondenceSources.entityId));
    expect(
      sourcesAfterReplacement.map(({ entityId }) => entityId).toSorted(),
    ).toEqual(
      (scenario.target === "existing"
        ? [sourceId, targetSourceId]
        : [sourceId]
      ).toSorted(),
    );
    const targetFilers = await testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, replacement.id));
    const targetAttachments = await testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, replacement.id));
    expect(targetFilers).toHaveLength(1);
    expect(targetAttachments.map(({ entityId }) => entityId)).toEqual([
      scenario.target === "existing"
        ? targetAttachmentId
        : replacementAttachmentId,
    ]);
    expect((await fileCopy(replacementOptions)).id).toBe(replacement.id);
    expect(
      await testDb
        .select()
        .from(correspondenceSources)
        .where(eq(correspondenceSources.correspondenceId, replacement.id))
        .orderBy(asc(correspondenceSources.entityId)),
    ).toEqual(sourcesAfterReplacement);
    expect(
      await testDb
        .select()
        .from(correspondenceFilers)
        .where(eq(correspondenceFilers.correspondenceId, replacement.id)),
    ).toEqual(targetFilers);
    expect(
      await testDb
        .select()
        .from(correspondenceAttachments)
        .where(eq(correspondenceAttachments.correspondenceId, replacement.id)),
    ).toEqual(targetAttachments);
    expect(
      await testDb
        .select({ currentVersionId: entities.currentVersionId })
        .from(entities)
        .where(eq(entities.id, sourceId)),
    ).toEqual([{ currentVersionId: secondVersionId }]);
  },
);

test("a failed replacement restores the old message and its source history atomically", async () => {
  const sourceId = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  await testDb.insert(entities).values(
    [sourceId, attachmentId].map((id) => ({
      id,
      workspaceId: ids.wsA1,
      name: "Atomic replacement fixture",
      createdBy: ids.userA1,
    })),
  );
  const firstVersionId = createSafeId<"entityVersion">();
  const secondVersionId = createSafeId<"entityVersion">();
  await testDb.insert(entityVersions).values({
    id: firstVersionId,
    workspaceId: ids.wsA1,
    entityId: sourceId,
    versionNumber: 1,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: firstVersionId })
    .where(eq(entities.id, sourceId));
  const oldParsed = await parsedDataBoxFixture({
    entityId: sourceId,
    messageId: "91000000009",
  });
  const old = await fileCopy({
    workspaceId: ids.wsA1,
    entityId: sourceId,
    parsed: oldParsed,
    attachmentId,
  });
  const record = () =>
    testDb.select().from(correspondence).where(eq(correspondence.id, old.id));
  const sources = () =>
    testDb
      .select()
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, old.id));
  const attachments = () =>
    testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, old.id));
  const filers = () =>
    testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, old.id));
  const initialRecord = await record();
  const initialSources = await sources();
  const initialAttachments = await attachments();
  const initialFilers = await filers();
  await testDb.insert(entityVersions).values({
    id: secondVersionId,
    workspaceId: ids.wsA1,
    entityId: sourceId,
    versionNumber: 2,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: secondVersionId })
    .where(eq(entities.id, sourceId));
  const replacementParsed = await parsedDataBoxFixture({
    entityId: sourceId,
    messageId: "91000000010",
  });
  expect(
    await rejectionOf(
      fileCopy({
        workspaceId: ids.wsA1,
        entityId: sourceId,
        parsed: replacementParsed,
        attachmentId: ids.entityA2,
      }),
    ),
  ).toMatchObject({ _tag: "DatabaseError", code: "23503" });
  expect(await record()).toEqual(initialRecord);
  expect(await sources()).toEqual(initialSources);
  expect(await attachments()).toEqual(initialAttachments);
  expect(await filers()).toEqual(initialFilers);
  expect(
    await testDb
      .select()
      .from(correspondence)
      .where(eq(correspondence.messageId, replacementParsed.messageId)),
  ).toEqual([]);
});

const sourceKinds = ["data_box", "email", "none"] as const;
type SourceKind = (typeof sourceKinds)[number];

type SourceStateFixtureOptions = {
  kind: Exclude<SourceKind, "none">;
  entityId: SafeId<"entity">;
  identity: string;
  contentHash: string;
};

const sourceStateFixture = async ({
  kind,
  entityId,
  identity,
  contentHash,
}: SourceStateFixtureOptions) => {
  switch (kind) {
    case "data_box":
      return {
        ...(await parsedDataBoxFixture({ entityId, messageId: identity })),
        contentHash,
      };
    case "email":
      return {
        channel: "email",
        dataBox: null,
        source: "upload",
        sourceEntityId: entityId,
        originalSignature: { status: "unverified" },
        direction: "in",
        messageId: `<${identity}@example.test>`,
        contentHash,
        from: { address: "sender@example.test", name: null },
        to: [],
        cc: [],
        subject: "Source transition fixture",
        sentAt: null,
        receivedAt: "2026-10-14T07:12:33.120Z",
        inReplyTo: null,
        references: [],
        bodyText: "Email body",
        bodyHtml: null,
      } satisfies ParsedCorrespondence;
    default:
      kind satisfies never;
      throw new Error("Unknown source fixture kind");
  }
};

type RetireSourceFixtureOptions = {
  entityId: SafeId<"entity">;
  expectedSourceVersionId: SafeId<"entityVersion">;
};

const retireSourceFixture = async ({
  entityId,
  expectedSourceVersionId,
}: RetireSourceFixtureOptions) => {
  const result = await retireCorrespondenceSource({
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    sourceEntityId: entityId,
    expectedSourceVersionId,
    recordAuditEvent: createAuditRecorder({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      request: new Request("https://api.example.test/v1/correspondence"),
      server: null,
    }),
  });
  if (result.type === "error") {
    throw result.error;
  }
  return { type: result.type, id: null };
};

type SetSourceVersionOptions = {
  entityId: SafeId<"entity">;
  versionNumber: number;
};

const setSourceVersion = async ({
  entityId,
  versionNumber,
}: SetSourceVersionOptions) => {
  const versionId = createSafeId<"entityVersion">();
  await testDb.insert(entityVersions).values({
    id: versionId,
    workspaceId: ids.wsA1,
    entityId,
    versionNumber,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  return versionId;
};

const sourceTransitions = sourceKinds.flatMap((oldKind, oldIndex) =>
  sourceKinds.flatMap((newKind, newIndex) =>
    (oldKind === "data_box"
      ? (["last", "retained"] as const)
      : (["last"] as const)
    ).map((oldCopies) => ({
      oldKind,
      oldIndex,
      newKind,
      newIndex,
      oldCopies,
    })),
  ),
);

test.each(sourceTransitions)(
  "source versions transition $oldKind to $newKind with $oldCopies old copy and back without stale associations",
  async ({ oldKind, oldIndex, newKind, newIndex, oldCopies }) => {
    const entityId = createSafeId<"entity">();
    const attachmentId = createSafeId<"entity">();
    const retainedSourceId = createSafeId<"entity">();
    await testDb.insert(entities).values(
      [entityId, attachmentId, retainedSourceId].map((id) => ({
        id,
        workspaceId: ids.wsA1,
        name: "Channel transition fixture",
        createdBy: ids.userA1,
      })),
    );
    const identity = String(
      92_000_000_000 +
        oldIndex * sourceKinds.length +
        newIndex +
        (oldCopies === "retained" ? sourceKinds.length ** 2 : 0),
    );
    const firstVersion = await setSourceVersion({
      entityId,
      versionNumber: 1,
    });
    const initialParsed =
      oldKind === "none"
        ? null
        : await sourceStateFixture({
            kind: oldKind,
            entityId,
            identity,
            contentHash: "1".repeat(64),
          });
    const initial =
      initialParsed === null
        ? await retireSourceFixture({
            entityId,
            expectedSourceVersionId: firstVersion,
          })
        : await fileCopy({
            workspaceId: ids.wsA1,
            entityId,
            parsed: initialParsed,
            attachmentId,
          });
    expect(initial.type).toBe("ok");
    const oldId = initial.id;
    if (oldCopies === "retained" && initialParsed !== null) {
      if (oldId === null) {
        throw new Error("A retained copy requires initial correspondence");
      }
      expect(
        (
          await fileCopy({
            workspaceId: ids.wsA1,
            entityId: retainedSourceId,
            parsed: initialParsed,
            attachmentId,
          })
        ).id,
      ).toBe(oldId);
    }
    const initialFilers =
      oldId === null
        ? []
        : await testDb
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, oldId));
    const initialAttachments =
      oldId === null
        ? []
        : await testDb
            .select()
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, oldId));
    const secondVersion = await setSourceVersion({
      entityId,
      versionNumber: 2,
    });
    const replacementParsed =
      newKind === "none"
        ? null
        : await sourceStateFixture({
            kind: newKind,
            entityId,
            identity:
              newKind === "data_box" && oldKind === "data_box"
                ? `${identity}1`
                : identity,
            contentHash: "2".repeat(64),
          });
    const applyReplacement = async () =>
      replacementParsed === null
        ? await retireSourceFixture({
            entityId,
            expectedSourceVersionId: secondVersion,
          })
        : await fileCopy({
            workspaceId: ids.wsA1,
            entityId,
            parsed: replacementParsed,
            attachmentId,
          });
    const replacement = await applyReplacement();
    expect(replacement.type).toBe("ok");
    const replacementId = replacement.id;
    const association = () =>
      testDb
        .select({ correspondenceId: correspondenceSources.correspondenceId })
        .from(correspondenceSources)
        .where(eq(correspondenceSources.entityId, entityId));
    expect(await association()).toEqual(
      replacementId === null ? [] : [{ correspondenceId: replacementId }],
    );
    if (oldId !== null) {
      expect(replacementId).not.toBe(oldId);
      expect(
        await testDb
          .select({ sourceEntityId: correspondence.sourceEntityId })
          .from(correspondence)
          .where(eq(correspondence.id, oldId)),
      ).toEqual(
        oldCopies === "retained" ? [{ sourceEntityId: retainedSourceId }] : [],
      );
      expect(
        await testDb
          .select({ entityId: correspondenceSources.entityId })
          .from(correspondenceSources)
          .where(eq(correspondenceSources.correspondenceId, oldId)),
      ).toEqual(
        oldCopies === "retained" ? [{ entityId: retainedSourceId }] : [],
      );
      expect(
        await testDb
          .select()
          .from(correspondenceAttachments)
          .where(eq(correspondenceAttachments.correspondenceId, oldId)),
      ).toEqual(oldCopies === "retained" ? initialAttachments : []);
      expect(
        await testDb
          .select()
          .from(correspondenceFilers)
          .where(eq(correspondenceFilers.correspondenceId, oldId)),
      ).toEqual(oldCopies === "retained" ? initialFilers : []);
    }
    if (replacementId !== null) {
      expect(
        await testDb
          .select({ sourceEntityId: correspondence.sourceEntityId })
          .from(correspondence)
          .where(eq(correspondence.id, replacementId)),
      ).toEqual([{ sourceEntityId: entityId }]);
    }
    const associationBeforeRetry = await association();
    const filersBeforeRetry =
      replacementId === null
        ? []
        : await testDb
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, replacementId));
    const attachmentsBeforeRetry =
      replacementId === null
        ? []
        : await testDb
            .select()
            .from(correspondenceAttachments)
            .where(
              eq(correspondenceAttachments.correspondenceId, replacementId),
            );
    if (replacementId !== null) {
      expect(filersBeforeRetry).toHaveLength(1);
      expect(attachmentsBeforeRetry).toHaveLength(1);
    }
    expect(await applyReplacement()).toMatchObject(
      replacementId === null
        ? { type: "ok" }
        : { type: "ok", id: replacementId },
    );
    expect(await association()).toEqual(associationBeforeRetry);
    if (replacementId !== null) {
      expect(
        await testDb
          .select()
          .from(correspondenceFilers)
          .where(eq(correspondenceFilers.correspondenceId, replacementId)),
      ).toEqual(filersBeforeRetry);
      expect(
        await testDb
          .select()
          .from(correspondenceAttachments)
          .where(eq(correspondenceAttachments.correspondenceId, replacementId)),
      ).toEqual(attachmentsBeforeRetry);
    }
    const thirdVersion = await setSourceVersion({
      entityId,
      versionNumber: 3,
    });
    const roundtrip =
      initialParsed === null
        ? await retireSourceFixture({
            entityId,
            expectedSourceVersionId: thirdVersion,
          })
        : await fileCopy({
            workspaceId: ids.wsA1,
            entityId,
            parsed: initialParsed,
            attachmentId,
          });
    expect(roundtrip.type).toBe("ok");
    const roundtripId = roundtrip.id;
    expect(await association()).toEqual(
      roundtripId === null ? [] : [{ correspondenceId: roundtripId }],
    );
    if (replacementId !== null) {
      expect(
        await testDb
          .select()
          .from(correspondence)
          .where(eq(correspondence.id, replacementId)),
      ).toEqual([]);
    }
    if (roundtripId !== null) {
      if (oldCopies === "retained") {
        if (oldId === null) {
          throw new Error("A retained copy requires initial correspondence");
        }
        expect(roundtripId).toBe(oldId);
        expect(
          await testDb
            .select()
            .from(correspondenceAttachments)
            .where(eq(correspondenceAttachments.correspondenceId, roundtripId)),
        ).toEqual(initialAttachments);
        expect(
          await testDb
            .select()
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.correspondenceId, roundtripId)),
        ).toEqual(initialFilers);
      } else {
        expect(roundtripId).not.toBe(oldId);
      }
      expect(
        await testDb
          .select()
          .from(correspondenceAttachments)
          .where(eq(correspondenceAttachments.correspondenceId, roundtripId)),
      ).toHaveLength(1);
      expect(
        await testDb
          .select()
          .from(correspondenceFilers)
          .where(eq(correspondenceFilers.correspondenceId, roundtripId)),
      ).toHaveLength(1);
    }
  },
);

test("stale filing and retirement cannot replace newer source correspondence", async () => {
  const entityId = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  await testDb.insert(entities).values(
    [entityId, attachmentId].map((id) => ({
      id,
      workspaceId: ids.wsA1,
      name: "Stale source fixture",
      createdBy: ids.userA1,
    })),
  );
  const firstVersion = await setSourceVersion({ entityId, versionNumber: 1 });
  const firstParsed = await sourceStateFixture({
    kind: "data_box",
    entityId,
    identity: "93000000001",
    contentHash: "3".repeat(64),
  });
  await fileCopy({
    workspaceId: ids.wsA1,
    entityId,
    parsed: firstParsed,
    attachmentId,
  });
  const secondVersion = await setSourceVersion({ entityId, versionNumber: 2 });
  const newerParsed = await sourceStateFixture({
    kind: "email",
    entityId,
    identity: "93000000002",
    contentHash: "4".repeat(64),
  });
  const newer = await fileCopy({
    workspaceId: ids.wsA1,
    entityId,
    parsed: newerParsed,
    attachmentId,
  });
  expect(
    await retireSourceFixture({
      entityId,
      expectedSourceVersionId: firstVersion,
    }),
  ).toMatchObject({ type: "source_changed" });
  for (const expectedSourceVersionId of [firstVersion, null]) {
    expect(
      await rejectionOf(
        fileCopy({
          workspaceId: ids.wsA1,
          entityId,
          parsed: firstParsed,
          attachmentId,
          expectedSourceVersionId,
        }),
      ),
    ).toMatchObject({
      message: "Expected filing success, received source_changed",
    });
  }
  expect(
    await testDb
      .select({ correspondenceId: correspondenceSources.correspondenceId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.entityId, entityId)),
  ).toEqual([{ correspondenceId: newer.id }]);
  expect(
    await testDb
      .select({
        sourceEntityId: correspondence.sourceEntityId,
        channel: correspondence.channel,
      })
      .from(correspondence)
      .where(eq(correspondence.id, newer.id)),
  ).toEqual([{ sourceEntityId: entityId, channel: "email" }]);
  expect(
    await testDb
      .select({ currentVersionId: entities.currentVersionId })
      .from(entities)
      .where(eq(entities.id, entityId)),
  ).toEqual([{ currentVersionId: secondVersion }]);
  expect(
    (
      await fileCopy({
        workspaceId: ids.wsA1,
        entityId,
        parsed: newerParsed,
        attachmentId,
      })
    ).id,
  ).toBe(newer.id);
});

test("new data-box bytes with the same message identity preserve the filed record", async () => {
  const entityId = createSafeId<"entity">();
  const attachmentId = createSafeId<"entity">();
  await testDb.insert(entities).values(
    [entityId, attachmentId].map((id) => ({
      id,
      workspaceId: ids.wsA1,
      name: "Stable message fixture",
      createdBy: ids.userA1,
    })),
  );
  await setSourceVersion({ entityId, versionNumber: 1 });
  const parsed = await parsedDataBoxFixture({
    entityId,
    messageId: "93000000003",
  });
  const options = { workspaceId: ids.wsA1, entityId, parsed, attachmentId };
  const first = await fileCopy(options);
  const attachments = () =>
    testDb
      .select()
      .from(correspondenceAttachments)
      .where(eq(correspondenceAttachments.correspondenceId, first.id));
  const filers = () =>
    testDb
      .select()
      .from(correspondenceFilers)
      .where(eq(correspondenceFilers.correspondenceId, first.id));
  const firstAttachments = await attachments();
  const firstFilers = await filers();
  await setSourceVersion({ entityId, versionNumber: 2 });
  const replacement = await fileCopy({
    ...options,
    parsed: { ...parsed, contentHash: "5".repeat(64) },
  });
  expect(replacement.id).toBe(first.id);
  expect(
    await testDb
      .select({ correspondenceId: correspondenceSources.correspondenceId })
      .from(correspondenceSources)
      .where(eq(correspondenceSources.entityId, entityId)),
  ).toEqual([{ correspondenceId: first.id }]);
  expect(await attachments()).toEqual(firstAttachments);
  expect(await filers()).toEqual(firstFilers);
});

test.each(["replace", "retire"] as const)(
  "legacy email upload pointers enroll before %s",
  async (outcome) => {
    const index = outcome === "replace" ? 0 : 1;
    const entityId = createSafeId<"entity">();
    const attachmentId = createSafeId<"entity">();
    await testDb.insert(entities).values(
      [entityId, attachmentId].map((id) => ({
        id,
        workspaceId: ids.wsA1,
        name: "Legacy email fixture",
        createdBy: ids.userA1,
      })),
    );
    await setSourceVersion({ entityId, versionNumber: 1 });
    const parsed = await sourceStateFixture({
      kind: "email",
      entityId,
      identity: String(94_000_000_000 + index),
      contentHash: "6".repeat(64),
    });
    const old = await fileCopy({
      workspaceId: ids.wsA1,
      entityId,
      parsed,
      attachmentId,
    });
    // Persisted uploads predate the source relation. Recreate that shape
    // without invoking today's last-source deletion protocol.
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE correspondence_sources DISABLE TRIGGER remove_correspondence_source`,
      );
      await tx
        .delete(correspondenceSources)
        .where(eq(correspondenceSources.correspondenceId, old.id));
      await tx.execute(
        sql`ALTER TABLE correspondence_sources ENABLE TRIGGER remove_correspondence_source`,
      );
    });
    expect(
      await testDb
        .select()
        .from(correspondenceSources)
        .where(eq(correspondenceSources.correspondenceId, old.id)),
    ).toEqual([]);
    expect(
      await testDb
        .select()
        .from(correspondence)
        .where(eq(correspondence.id, old.id)),
    ).toHaveLength(1);
    const newVersion = await setSourceVersion({ entityId, versionNumber: 2 });
    const replacement =
      outcome === "retire"
        ? await retireSourceFixture({
            entityId,
            expectedSourceVersionId: newVersion,
          })
        : await fileCopy({
            workspaceId: ids.wsA1,
            entityId,
            attachmentId,
            parsed: await sourceStateFixture({
              kind: "data_box",
              entityId,
              identity: String(94_000_000_002 + index),
              contentHash: "7".repeat(64),
            }),
          });
    expect(replacement.type).toBe("ok");
    expect(
      await testDb
        .select()
        .from(correspondence)
        .where(eq(correspondence.id, old.id)),
    ).toEqual([]);
    expect(
      await testDb
        .select()
        .from(correspondenceAttachments)
        .where(eq(correspondenceAttachments.correspondenceId, old.id)),
    ).toEqual([]);
    expect(
      await testDb
        .select()
        .from(correspondenceFilers)
        .where(eq(correspondenceFilers.correspondenceId, old.id)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ correspondenceId: correspondenceSources.correspondenceId })
        .from(correspondenceSources)
        .where(eq(correspondenceSources.entityId, entityId)),
    ).toEqual(
      replacement.id === null ? [] : [{ correspondenceId: replacement.id }],
    );
  },
);
