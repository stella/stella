import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { entities, entityVersions, fields, properties } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { EnqueueSharePublicationOptions } from "@/api/handlers/share-spaces/share-publish-queue";
import { hashShareInvitationSecret } from "@/api/handlers/share-spaces/token";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const queuedPublications: EnqueueSharePublicationOptions[] = [];
const enqueueSharePublicationMock = mock(
  async (options: EnqueueSharePublicationOptions) => {
    queuedPublications.push(options);
  },
);

void mock.module("@/api/handlers/share-spaces/share-publish-queue", () => ({
  enqueueSharePublication: enqueueSharePublicationMock,
}));

const { default: createShareSpace } =
  await import("@/api/handlers/share-spaces/create");

let testDb: TestDatabase;
let ids: TestIds;

const sourceEntityId = createSafeId<"entity">();
const sourceVersionId = createSafeId<"entityVersion">();
const sourcePropertyId = createSafeId<"property">();
const sourceFieldId = createSafeId<"field">();
const SOURCE_SHA = "c".repeat(64);

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;

    await testDb.insert(properties).values({
      id: sourcePropertyId,
      workspaceId: ids.wsA1,
      name: "Publishable file",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
      status: "fresh",
    });
    await testDb.insert(entities).values({
      id: sourceEntityId,
      workspaceId: ids.wsA1,
      name: "transaction.pdf",
      displayName: "Transaction document",
      createdBy: ids.userA1,
    });
    await testDb.insert(entityVersions).values({
      id: sourceVersionId,
      workspaceId: ids.wsA1,
      entityId: sourceEntityId,
      versionNumber: 2,
      stamp: "2026/001/002.v2",
      verificationCode: "ZXCV1234",
      createdBy: ids.userA1,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: sourceVersionId })
      .where(eq(entities.id, sourceEntityId));
    await testDb.insert(fields).values({
      id: sourceFieldId,
      workspaceId: ids.wsA1,
      propertyId: sourcePropertyId,
      entityVersionId: sourceVersionId,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "transaction.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4096,
        encrypted: false,
        sha256Hex: SOURCE_SHA,
        pdfFileId: null,
        pdfDerivative: { status: "not-required" },
      },
    });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

const createContext = (overrides?: {
  expiresAt?: string | null;
  entityId?: typeof sourceEntityId;
}) => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const auditEvents: AuditEvent[] = [];
  const context = asTestRaw<Parameters<typeof createShareSpace.handler>[0]>({
    workspaceId: ids.wsA1,
    user: { id: ids.userA1 },
    session: { activeOrganizationId: ids.orgA },
    memberRole: { role: "member" },
    body: {
      entityId: overrides?.entityId ?? sourceEntityId,
      entityVersionId: sourceVersionId,
      fieldId: sourceFieldId,
      recipientEmail: "Recipient@Example.COM",
      downloadPolicy: "blocked",
      expiresAt: overrides?.expiresAt ?? null,
    },
    safeDb: toSafeDbMock(asTestRaw(scopedDb)),
    recordAuditEvent: async (
      _tx: unknown,
      event: AuditEvent | AuditEvent[],
    ) => {
      auditEvents.push(...(Array.isArray(event) ? event : [event]));
    },
  });
  return { auditEvents, context };
};

describe("create single-document Share Space", () => {
  test("pins the source, stores only a token hash, normalizes the recipient, and queues copying", async () => {
    queuedPublications.length = 0;
    const { auditEvents, context } = createContext();

    const result = await createShareSpace.handler(context);
    if (!("shareSpaceId" in result)) {
      throw new Error("expected Share Space creation to succeed");
    }

    expect(result.status).toBe("publishing");
    expect(result.invitationSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(queuedPublications).toHaveLength(1);
    expect(queuedPublications.at(0)).toMatchObject({
      shareSpaceId: result.shareSpaceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    });

    const space = await testDb.query.shareSpaces.findFirst({
      where: { id: { eq: result.shareSpaceId } },
    });
    const recipient = await testDb.query.shareRecipients.findFirst({
      where: { shareSpaceId: { eq: result.shareSpaceId } },
    });
    const item = await testDb.query.shareItems.findFirst({
      where: { shareSpaceId: { eq: result.shareSpaceId } },
    });

    expect(space).toMatchObject({
      status: "publishing",
      workspaceId: ids.wsA1,
      accessTokenHash: hashShareInvitationSecret(result.invitationSecret),
    });
    expect(space?.accessTokenHash).not.toContain(result.invitationSecret);
    expect(recipient).toMatchObject({
      emailNormalized: "recipient@example.com",
      status: "invited",
      userId: null,
    });
    expect(item).toMatchObject({
      sourceEntityId,
      sourceEntityVersionId: sourceVersionId,
      sourceFieldId,
      originalSha256Hex: SOURCE_SHA,
      status: "publishing",
    });
    expect(auditEvents.map(({ resourceType }) => resourceType)).toEqual([
      "share_space",
      "share_recipient",
      "share_item",
    ]);
  });

  test("rejects an already-expired publication before touching the database", async () => {
    queuedPublications.length = 0;
    const { context } = createContext({
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const result = await createShareSpace.handler(context);

    expect(result).toMatchObject({
      code: 400,
      response: { message: "Share Space expiration must be in the future." },
    });
    expect(queuedPublications).toEqual([]);
  });

  test("cross-document IDs fail without revealing which source exists", async () => {
    queuedPublications.length = 0;
    const { context } = createContext({ entityId: ids.entityA2 });

    const result = await createShareSpace.handler(context);

    expect(result).toMatchObject({
      code: 400,
      response: { message: "Document version or file field not found." },
    });
    expect(queuedPublications).toEqual([]);
  });
});
