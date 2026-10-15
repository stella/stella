import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceAttachments,
  correspondenceFilers,
  correspondenceSources,
  entities,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { parseDataBoxMessage } from "@/api/lib/data-box/zfo";
import { zfoFile } from "@/api/lib/data-box/zfo.test-fixture";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
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
};

const fileCopy = async ({
  workspaceId,
  entityId,
  parsed,
  attachmentId,
}: FileCopyOptions) => {
  const result = await createCorrespondence({
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], ids.orgA, ids.userA1),
    ),
    organizationId: ids.orgA,
    workspaceId,
    filer: { type: "user", userId: ids.userA1 },
    parsed: { ...parsed, sourceEntityId: entityId },
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
    dataBox: { ...envelope, directionBasis: "unknown" },
    direction: "in",
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

  await testDb.delete(entities).where(eq(entities.id, firstSource));
  expect(await sources()).toEqual([{ entityId: secondSource }]);
  expect(
    await testDb
      .select({ sourceEntityId: correspondence.sourceEntityId })
      .from(correspondence)
      .where(eq(correspondence.id, first.id)),
  ).toEqual([{ sourceEntityId: secondSource }]);
  expect(await filers()).toEqual(initialFilers);
  expect(await attachments()).toEqual(initialAttachments);

  await testDb.delete(entities).where(eq(entities.id, secondSource));
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
  await testDb.insert(entities).values(
    [entityId, attachmentId].map((id) => ({
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
  expect(
    await testDb
      .select()
      .from(correspondence)
      .where(eq(correspondence.id, record.id)),
  ).toHaveLength(1);
  expect(
    await testDb
      .select()
      .from(correspondenceSources)
      .where(eq(correspondenceSources.correspondenceId, record.id)),
  ).toEqual([]);
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
});
