import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entityVersions, fields } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import thumbnailEndpoint from "./thumbnail";

const thumbnailFileId = "7d0f3c1e-9f7c-4c52-9a3d-0f1c2b3a4d5e";

type ThumbnailContext = Parameters<typeof thumbnailEndpoint.handler>[0];

const ids = createTestIds();
let database: TestDatabase;
let storedContent: Record<string, unknown> = {};

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
beforeAll(async () => {
  database = await getTestDb();
  await setupRlsTestData(database, ids);
  const stored = await database
    .select({ content: fields.content })
    .from(fields)
    .where(eq(fields.id, ids.fileFieldA1));
  storedContent = asTestRaw<Record<string, unknown>>(stored.at(0)?.content);
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

const setFileContent = async (overrides: Record<string, unknown>) => {
  await database
    .update(fields)
    .set({
      content: asTestRaw<(typeof fields.$inferInsert)["content"]>({
        ...storedContent,
        ...overrides,
      }),
    })
    .where(eq(fields.id, ids.fileFieldA1));
};

beforeEach(async () => {
  await setFileContent({ mimeType: "image/png", thumbnailFileId });
  await database
    .update(entityVersions)
    .set({ deletedAt: null })
    .where(eq(entityVersions.id, ids.entityVersionA1));
});

const memberScopedDb = () =>
  asTestRaw<ScopedDb>(
    createMembershipScopedDb(markRlsDatabase(database), {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [ids.wsA1],
      userId: ids.userA1,
    }),
  );

const readFileThumbnail = async ({
  fieldId = ids.fileFieldA1,
  recordAuditEvent,
}: {
  fieldId?: typeof ids.fileFieldA1;
  recordAuditEvent: AuditRecorder;
}) => {
  const scopedDb = memberScopedDb();
  return await thumbnailEndpoint.handler(
    asTestRaw<ThumbnailContext>({
      memberRole: sessionMemberRole("owner"),
      params: { fieldId, workspaceId: ids.wsA1 },
      recordAuditEvent,
      request: new Request(
        `https://example.test/v1/files/${ids.wsA1}/thumbnail/${fieldId}`,
      ),
      route: "/v1/files/:workspaceId/thumbnail/:fieldId" satisfies ApiRoutePath,
      scopedDb,
      safeDb: toSafeDbMock(scopedDb),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      workspaceId: ids.wsA1,
    }),
  );
};

const recordingAudit = () => {
  const events: AuditEvent[] = [];
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    if (Array.isArray(event)) {
      events.push(...event);
    } else {
      events.push(event);
    }
  };
  return { events, recordAuditEvent };
};

const expectStatus = (response: unknown, code: number) => {
  expect(response).toBeInstanceOf(HttpStatusResponse);
  if (response instanceof HttpStatusResponse) {
    expect(response.code).toBe(code);
  }
};

describe("matter file thumbnail", () => {
  test("redirects to the signed thumbnail and audits the read", async () => {
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({ recordAuditEvent });

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    const thumbnailKey = createFileKey({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      fileId: thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(thumbnailKey);
    const expiresIn = Number(
      new URL(response.headers.get("location") ?? "").searchParams.get(
        "X-Amz-Expires",
      ),
    );
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(60);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(events).toEqual([
      expect.objectContaining({
        action: "access",
        resourceId: ids.entityA1,
        resourceType: "entity",
        workspaceId: ids.wsA1,
        metadata: expect.objectContaining({
          fieldId: ids.fileFieldA1,
          s3Key: thumbnailKey,
          variant: "thumbnail",
        }),
      }),
    ]);
  });

  test("answers 404 without auditing for a tombstoned version", async () => {
    await database
      .update(entityVersions)
      .set({ deletedAt: new Date("2026-02-01T00:00:00.000Z") })
      .where(eq(entityVersions.id, ids.entityVersionA1));
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({ recordAuditEvent });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });

  test("answers 404 without auditing for a field outside the workspace", async () => {
    // The lookup joins the field to an entity of the route's matter; another
    // organization's field yields no row.
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      fieldId: ids.fileFieldB1,
      recordAuditEvent,
    });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });

  test.each([
    ["no generated thumbnail", { thumbnailFileId: null }],
    ["a thumbnail field absent", { thumbnailFileId: undefined }],
    ["an encrypted file", { encrypted: true }],
  ])("answers 404 without auditing for %s", async (_label, overrides) => {
    await setFileContent({ mimeType: "image/png", ...overrides });
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({ recordAuditEvent });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });

  test("answers 404 for a field that is not a file", async () => {
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      fieldId: ids.fieldA1,
      recordAuditEvent,
    });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });
});
