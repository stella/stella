import { describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import thumbnailEndpoint from "./thumbnail";

const organizationId = toSafeId<"organization">("org_file_thumbnail");
const workspaceId = toSafeId<"workspace">("ws_file_thumbnail");
const fieldId = toSafeId<"field">("field_file_thumbnail");
const entityId = toSafeId<"entity">("entity_file_thumbnail");
const thumbnailFileId = "7d0f3c1e-9f7c-4c52-9a3d-0f1c2b3a4d5e";

type ThumbnailContext = Parameters<typeof thumbnailEndpoint.handler>[0];

const readFileThumbnail = async ({
  recordAuditEvent,
  scopedDb,
}: Pick<ThumbnailContext, "recordAuditEvent" | "scopedDb">) =>
  await thumbnailEndpoint.handler(
    asTestRaw<ThumbnailContext>({
      memberRole: sessionMemberRole("owner"),
      params: { fieldId, workspaceId },
      recordAuditEvent,
      request: new Request("https://example.test/files/thumbnail"),
      route: "/v1/workspaces/:workspaceId/files/thumbnail/:fieldId",
      scopedDb,
      safeDb: toSafeDbMock(scopedDb),
      session: { activeOrganizationId: organizationId },
      user: { id: toSafeId<"user">("user_file_thumbnail") },
      workspaceId,
    }),
  );

const fileContent = (overrides: Record<string, unknown> = {}) => ({
  type: "file",
  id: "0b8d2e4f-6a1c-4e3b-8d7f-9a0b1c2d3e4f",
  fileName: "site-photo.png",
  mimeType: "image/png",
  encrypted: false,
  thumbnailFileId,
  ...overrides,
});

/**
 * The first scopedDb call is the workspace-bound field lookup: `rows` stands
 * for what that lookup answers. Later calls run the audited presign.
 */
const scopedDbAnswering = (rows: unknown[]) => {
  let call = 0;
  return asTestRaw<ScopedDb>(
    async (callback: (tx: object) => Promise<unknown>) => {
      call += 1;
      if (call === 1) {
        return rows.length === 0 ? [] : [{ id: fieldId }];
      }
      if (call === 2) {
        return rows;
      }
      return await callback({});
    },
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
  expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
  if (response instanceof ElysiaCustomStatusResponse) {
    expect(response.code).toBe(code);
  }
};

describe("matter file thumbnail", () => {
  test("redirects to the signed thumbnail and audits the read", async () => {
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      recordAuditEvent,
      scopedDb: scopedDbAnswering([{ content: fileContent(), entityId }]),
    });

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    const thumbnailKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(thumbnailKey);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(events).toEqual([
      expect.objectContaining({
        action: "access",
        resourceId: entityId,
        resourceType: "entity",
        workspaceId,
        metadata: expect.objectContaining({
          fieldId,
          s3Key: thumbnailKey,
          variant: "thumbnail",
        }),
      }),
    ]);
  });

  test("answers 404 without auditing for a field outside the workspace", async () => {
    // The lookup joins the field to an entity of `workspaceId`; another
    // matter's field (or a tombstoned version) yields no row.
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      recordAuditEvent,
      scopedDb: scopedDbAnswering([]),
    });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });

  test.each([
    ["no generated thumbnail", { thumbnailFileId: null }],
    ["a thumbnail field absent", { thumbnailFileId: undefined }],
    ["an encrypted file", { encrypted: true }],
  ])("answers 404 without auditing for %s", async (_label, overrides) => {
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      recordAuditEvent,
      scopedDb: scopedDbAnswering([
        { content: fileContent(overrides), entityId },
      ]),
    });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });

  test("answers 404 for a field that is not a file", async () => {
    const { events, recordAuditEvent } = recordingAudit();

    const response = await readFileThumbnail({
      recordAuditEvent,
      scopedDb: scopedDbAnswering([
        { content: { type: "text", value: "Smlouva" }, entityId },
      ]),
    });

    expectStatus(response, 404);
    expect(events).toEqual([]);
  });
});
