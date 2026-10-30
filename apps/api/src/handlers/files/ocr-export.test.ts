import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { documentProcessingRuns, extractedContent } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readOcrExport } from "./ocr-export";

const organizationId = toSafeId<"organization">("org_ocr_export");
const workspaceId = toSafeId<"workspace">("ws_ocr_export");
const fieldId = toSafeId<"field">("field_ocr_export");
const entityId = toSafeId<"entity">("entity_ocr_export");
const runId = toSafeId<"documentProcessingRun">("run_ocr_export");
const userId = toSafeId<"user">("user_ocr_export");

describe("OCR text export", () => {
  test("returns the current projection as UTF-8 text and audits the download", async () => {
    let scopedDbCall = 0;
    const events: AuditEvent[] = [];
    const scopedDb = asTestRaw<ScopedDb>(
      async (callback: (tx: object) => Promise<unknown>) => {
        scopedDbCall += 1;
        if (scopedDbCall === 1) {
          return {
            content: { fileName: "smlouva.pdf", type: "file" },
            entityId,
            ocrRunId: runId,
            readText: async () => await Promise.resolve("Příliš žluťoučký kůň"),
          };
        }
        return await callback({});
      },
    );
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        events.push(...event);
      } else {
        events.push(event);
      }
    };

    const response = await readOcrExport({
      source: { kind: "request", sessionId: "fixture-session" },
      readSessionAuthority: async () => null,
      fieldId,
      format: "text",
      userId,
      organizationId,
      recordAuditEvent,
      scopedDb,
      workspaceId,
    });

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    expect(await response.text()).toBe("Příliš žluťoučký kůň");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toContain(
      'filename="smlouva.txt"',
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: "download",
        metadata: { fieldId, format: "text" },
        resourceId: entityId,
        resourceType: "entity",
      }),
    ]);
  });

  test("a searchable PDF export never decrypts the extracted text", async () => {
    const fake = startFakeS3();
    let decryptions = 0;
    let scopedDbCall = 0;
    try {
      const scopedDb = asTestRaw<ScopedDb>(
        async (callback: (tx: object) => Promise<unknown>) => {
          scopedDbCall += 1;
          if (scopedDbCall === 1) {
            return {
              content: { fileName: "smlouva.pdf", type: "file" },
              entityId,
              ocrRunId: runId,
              readText: async () => {
                decryptions += 1;
                return await Promise.reject(new Error("text unavailable"));
              },
            };
          }
          return await callback({});
        },
      );
      const response = await readOcrExport({
        source: { kind: "request", sessionId: "fixture-session" },
        readSessionAuthority: async () => null,
        fieldId,
        format: "searchable-pdf",
        organizationId,
        recordAuditEvent: async () => await Promise.resolve(),
        scopedDb,
        userId,
        workspaceId,
      });
      // No stored PDF in the fake store: the export answers from metadata alone.
      expect(response).toBeInstanceOf(HttpStatusResponse);
      expect(decryptions).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("returns 404 without auditing when no tenant-scoped current projection exists", async () => {
    let audited = false;
    const scopedDb = asTestRaw<ScopedDb>(async () => null);

    const response = await readOcrExport({
      source: { kind: "request", sessionId: "fixture-session" },
      readSessionAuthority: async () => null,
      fieldId,
      format: "text",
      userId,
      organizationId,
      recordAuditEvent: async () => {
        audited = true;
      },
      scopedDb,
      workspaceId,
    });

    expect(response).toBeInstanceOf(HttpStatusResponse);
    if (response instanceof HttpStatusResponse) {
      expect(response.code).toBe(404);
    }
    expect(audited).toBe(false);
  });
});

describe("OCR text export matter access", () => {
  const ids = createTestIds();
  let database: TestDatabase;

  beforeAll(async () => {
    database = await getTestDb();
    await setupRlsTestData(database, ids);
    const ocrRunId = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7());
    await database.insert(documentProcessingRuns).values({
      id: ocrRunId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      entityVersionId: ids.entityVersionA1,
      fieldId: ids.fileFieldA1,
      sourceFileId: ids.fileObjectA1,
      sourceSha256Hex: "a".repeat(64),
      kind: "ocr",
      requestSource: "upload",
      status: "succeeded",
    });
    await database
      .update(extractedContent)
      .set({
        ocrRunId,
        ocrPayloadCiphertext: Buffer.from("page geometry"),
        ocrPayloadIv: Buffer.alloc(12),
      })
      .where(eq(extractedContent.entityId, ids.entityA1));
  }, 120_000);

  afterAll(async () => {
    await releaseTestDb();
  });

  const read = async ({
    memberId,
    workspaceIds,
  }: {
    memberId: typeof ids.userA1;
    workspaceIds: (typeof ids.wsA1)[];
  }) =>
    await readOcrExport({
      source: { kind: "request", sessionId: "fixture-session" },
      readSessionAuthority: async () => null,
      fieldId: ids.fileFieldA1,
      format: "text",
      organizationId: ids.orgA,
      recordAuditEvent: async () => undefined,
      scopedDb: asTestRaw<ScopedDb>(
        createMembershipScopedDb(markRlsDatabase(database), {
          organizationId: ids.orgA,
          serverValidatedWorkspaceIds: workspaceIds,
          userId: memberId,
        }),
      ),
      userId: memberId,
      workspaceId: ids.wsA1,
    });

  test("exports a readable matter and returns not found for an unreadable matter", async () => {
    const readable = await read({
      memberId: ids.userA1,
      workspaceIds: [ids.wsA1],
    });
    expect(readable).toBeInstanceOf(Response);
    if (readable instanceof Response) {
      expect(await readable.text()).toBe("extracted text a1");
    }

    const unreadable = await read({
      memberId: ids.userA2,
      workspaceIds: [ids.wsA2],
    });
    expect(unreadable).toBeInstanceOf(HttpStatusResponse);
    if (unreadable instanceof HttpStatusResponse) {
      expect(unreadable.code).toBe(404);
      expect(JSON.stringify(unreadable.response)).not.toContain(
        "extracted text a1",
      );
    }
  });
});
