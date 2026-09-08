import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { createAuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { CreateStoredTemplateOptions } from "@/api/lib/templates/create-template";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";

import {
  DD_REPORT_KEY,
  getBuiltinReportTemplate,
  initBuiltinReportTemplates,
} from "./builtin-templates";
import { createCloneBuiltinReportTemplate } from "./clone-builtin";
import type { CloneBuiltinReportTemplateDependencies } from "./clone-builtin";

// The fidelity regression this file guards is that a clone of the built-in
// fills the way the built-in does. The configuration travels in the bytes, so
// the assertion is about the document the handler hands the storage service.
const capturedOptions: CreateStoredTemplateOptions[] = [];
const createStoredTemplateMock = mock(function* (
  options: CreateStoredTemplateOptions,
) {
  capturedOptions.push(options);
  return Result.ok({
    id: toSafeId<"template">("template_1"),
    name: options.name,
    fileName: options.fileName,
    fieldCount: 0,
    currentVersion: 1,
    categoryId: null,
  });
});

const cloneBuiltinReportTemplate = createCloneBuiltinReportTemplate({
  createStoredTemplate: asTestRaw<
    CloneBuiltinReportTemplateDependencies["createStoredTemplate"]
  >(createStoredTemplateMock),
});
await initBuiltinReportTemplates();

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
    // The built-in's own markers carry its two AI-drafted fields, including
    // the per-item `contracts.summary` written through the loop's alias, so a
    // clone drafts exactly what the built-in drafts.
    const manifest = await deriveManifestFromDocx(options.buffer);
    const aiFields = manifest.fields.filter(
      (field) => field.aiPrompt !== undefined,
    );
    expect(aiFields.map(({ path }) => path).toSorted()).toEqual([
      "contracts.summary",
      "execSummary",
    ]);
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
