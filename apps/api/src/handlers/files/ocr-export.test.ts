import { describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { readOcrExport } from "./ocr-export";

const organizationId = toSafeId<"organization">("org_ocr_export");
const workspaceId = toSafeId<"workspace">("ws_ocr_export");
const fieldId = toSafeId<"field">("field_ocr_export");
const entityId = toSafeId<"entity">("entity_ocr_export");
const runId = toSafeId<"documentProcessingRun">("run_ocr_export");

describe("OCR text export", () => {
  test("returns the current projection as UTF-8 text and audits the download", async () => {
    let scopedDbCall = 0;
    const events: AuditEvent[] = [];
    const scopedDb = asTestRaw<ScopedDb>(
      async (callback: (tx: object) => Promise<unknown>) => {
        scopedDbCall += 1;
        if (scopedDbCall === 1) {
          return [
            {
              ciphertext: Buffer.from("Příliš žluťoučký kůň"),
              content: { fileName: "smlouva.pdf", type: "file" },
              entityId,
              iv: Buffer.alloc(12),
              ocrRunId: runId,
            },
          ];
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
      fieldId,
      format: "text",
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

  test("returns 404 without auditing when no tenant-scoped current projection exists", async () => {
    let audited = false;
    const scopedDb = asTestRaw<ScopedDb>(async () => []);

    const response = await readOcrExport({
      fieldId,
      format: "text",
      organizationId,
      recordAuditEvent: async () => {
        audited = true;
      },
      scopedDb,
      workspaceId,
    });

    expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (response instanceof ElysiaCustomStatusResponse) {
      expect(response.code).toBe(404);
    }
    expect(audited).toBe(false);
  });
});
