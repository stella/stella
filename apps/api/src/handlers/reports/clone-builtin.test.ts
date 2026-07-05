import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { CreateStoredTemplateOptions } from "@/api/handlers/templates/create-template-service";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// The real `createStoredTemplate` cannot be exercised here: the MCP template
// tools test mocks its module, and Bun's `mock.module` poisons the module for
// the whole test process regardless of file order. Test the handler at the
// service seam instead — the manifest-fidelity regression this file guards
// (verbatim registry manifest, no discovery merge) lives entirely in what the
// handler PASSES to the service.
const capturedOptions: CreateStoredTemplateOptions[] = [];
const createStoredTemplateMock = mock(function* (
  options: CreateStoredTemplateOptions,
) {
  capturedOptions.push(options);
  return Result.ok({
    id: toSafeId<"template">("template_1"),
    name: options.name,
    fileName: options.fileName,
    fieldCount: options.manifest?.fields.length ?? 0,
    currentVersion: 1,
    categoryId: null,
  });
});

void mock.module("@/api/handlers/templates/create-template-service", () => ({
  createStoredTemplate: createStoredTemplateMock,
}));

const { default: cloneBuiltinReportTemplate } = await import("./clone-builtin");
const { DD_REPORT_KEY, DD_REPORT_MANIFEST, getBuiltinReportTemplate } =
  await import("./builtin-templates");

const workspaceId = toSafeId<"workspace">("workspace_1");
const userId = toSafeId<"user">("user_1");
const organizationId = toSafeId<"organization">("organization_1");

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
  test("passes the registry manifest verbatim with kind report", async () => {
    capturedOptions.length = 0;
    const tx = {
      query: {
        // No same-named template exists → keep the built-in's name.
        templates: { findFirst: async () => undefined },
      },
    };

    const { safeDb } = createScopedDbMock(tx);
    const result = await cloneBuiltinReportTemplate.handler(
      createContext(safeDb, DD_REPORT_KEY),
    );

    expect(result).toEqual({ templateId: expect.any(String) });
    const options = capturedOptions.at(0);
    if (!options) {
      throw new Error("expected createStoredTemplate to be called");
    }
    expect(options.kind).toBe("report");
    // Verbatim: the registry manifest object itself, not a re-discovered or
    // rebuilt copy — a discovery merge would fold the per-item
    // `contracts.summary` AI field into the `contracts` array root and drop
    // it, so the clone would stop drafting per-contract summaries.
    expect(options.manifest).toBe(DD_REPORT_MANIFEST);
    const contractSummary = options.manifest?.fields.find(
      (field) => field.path === "contracts.summary",
    );
    expect(contractSummary?.aiPrompt).toBeDefined();
    const execSummary = options.manifest?.fields.find(
      (field) => field.path === "execSummary",
    );
    expect(execSummary?.aiPrompt).toBeDefined();
    const builtin = getBuiltinReportTemplate(DD_REPORT_KEY);
    expect(options.name).toBe(builtin?.name ?? "");
    expect(options.fileName).toBe(`${builtin?.name ?? ""}.docx`);
    expect(options.buffer.byteLength).toBeGreaterThan(0);
  });

  test("appends (copy) when a same-named template exists", async () => {
    capturedOptions.length = 0;
    const tx = {
      query: {
        templates: { findFirst: async () => ({ id: "existing" }) },
      },
    };

    const { safeDb } = createScopedDbMock(tx);
    await cloneBuiltinReportTemplate.handler(
      createContext(safeDb, DD_REPORT_KEY),
    );

    const builtin = getBuiltinReportTemplate(DD_REPORT_KEY);
    expect(capturedOptions.at(0)?.name).toBe(`${builtin?.name ?? ""} (copy)`);
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
