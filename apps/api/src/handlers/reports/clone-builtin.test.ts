import { describe, expect, mock, test } from "bun:test";

import { auditLogs, templates, templateVersions } from "@/api/db/schema";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const writeMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ delete: s3DeleteMock, write: writeMock }),
}));

const { default: cloneBuiltinReportTemplate } = await import("./clone-builtin");
const { DD_REPORT_KEY, DD_REPORT_MANIFEST } =
  await import("./builtin-templates");

const workspaceId = toSafeId<"workspace">("workspace_1");
const userId = toSafeId<"user">("user_1");
const organizationId = toSafeId<"organization">("organization_1");

type InsertedTemplate = {
  id: string;
  name: string;
  kind: string;
  fileName: string;
  manifest: TemplateManifest;
  fieldCount: number;
};

const isInsertedTemplate = (value: unknown): value is InsertedTemplate =>
  typeof value === "object" && value !== null && "kind" in value;

const createContext = (
  safeDb: ReturnType<typeof createScopedDbMock>["safeDb"],
  key: string,
): Parameters<typeof cloneBuiltinReportTemplate.handler>[0] => {
  const recorderBindings = {
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/v1/reports/templates/clone"),
    server: null,
  };
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields the handler touches
  return {
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body: { key },
    request: recorderBindings.request,
    route: "/v1/workspaces/:workspaceId/reports/templates/clone-builtin",
    safeDb,
    recordAuditEvent: createAuditRecorder(recorderBindings),
    createAuditRecorder: () => createAuditRecorder(recorderBindings),
  } as Parameters<typeof cloneBuiltinReportTemplate.handler>[0];
};

describe("clone built-in report template", () => {
  test("inserts a report-kind template carrying the built-in manifest", async () => {
    const insertedTemplates: InsertedTemplate[] = [];

    const tx = {
      query: {
        // No same-named template exists → keep the built-in's name.
        templates: { findFirst: async () => undefined },
      },
      execute: async () => undefined,
      $count: async () => 0,
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === templates) {
            if (!isInsertedTemplate(value)) {
              throw new Error("Invalid inserted template fixture value");
            }
            insertedTemplates.push(value);
            return { returning: async () => [value] };
          }
          if (table === templateVersions || table === auditLogs) {
            return undefined;
          }
          return undefined;
        },
      }),
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await cloneBuiltinReportTemplate.handler(
      createContext(safeDb, DD_REPORT_KEY),
    );

    expect(result).toEqual({ templateId: expect.any(String) });
    const row = insertedTemplates.at(0);
    if (!row) {
      throw new Error("expected a template row to be inserted");
    }
    expect(row.kind).toBe("report");
    // The registry manifest is stored verbatim (no discovery merge), so the
    // clone fills identically to the built-in. In particular the per-item
    // `contracts.summary` AI field — which a discovery merge would fold into
    // the `contracts` array root and drop — survives with its aiPrompt, and so
    // does the top-level `execSummary` field.
    expect(row.manifest).toEqual(DD_REPORT_MANIFEST);
    const execSummary = row.manifest.fields.find(
      (field) => field.path === "execSummary",
    );
    expect(execSummary?.aiPrompt).toBeDefined();
    const contractSummary = row.manifest.fields.find(
      (field) => field.path === "contracts.summary",
    );
    expect(contractSummary?.aiPrompt).toBeDefined();
    expect(row.fieldCount).toBe(DD_REPORT_MANIFEST.fields.length);
    expect(writeMock).toHaveBeenCalled();
  });

  test("rejects an unknown built-in key with a 400", async () => {
    const { safeDb } = createScopedDbMock({});
    const result = await cloneBuiltinReportTemplate.handler(
      createContext(safeDb, "does-not-exist"),
    );

    expect(result).toMatchObject({
      response: {
        message: expect.stringContaining("Unknown built-in report template"),
      },
    });
  });
});
