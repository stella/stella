import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { DIRECTIVE_KINDS } from "@stll/template-conditions";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const describeStoredTemplateMock = mock();
const fillStoredTemplateWithTextMock = mock();
const createStoredTemplateMock = mock();
const validateDocxBufferMock = mock();
const loadOrgAIConfigMock = mock();
const captureErrorMock = mock();

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: () => ({ capture: mock(), flush: mock(async () => undefined) }),
}));

void mock.module("@/api/handlers/templates/template-fill-service", () => ({
  describeStoredTemplate: describeStoredTemplateMock,
  fillStoredTemplateWithText: fillStoredTemplateWithTextMock,
}));

void mock.module("@/api/handlers/templates/create-template-service", () => ({
  createStoredTemplate: createStoredTemplateMock,
}));

void mock.module("@/api/handlers/entities/validate-docx-buffer", () => ({
  validateDocxBuffer: validateDocxBufferMock,
}));

// Stubbed so the fill handler never reaches the real (DB-backed) config
// loader or AI model chain; a null config makes AI fields a no-op.
void mock.module("@/api/lib/ai-config-loader", () => ({
  loadOrgAIConfig: loadOrgAIConfigMock,
  loadPromptCachingPreference: mock(async () => false),
}));

void mock.module("@/api/handlers/docx/ai-field-generator", () => ({
  buildAiFieldGenerator: mock(() => undefined),
  buildAiOccurrenceAdapter: mock(() => undefined),
}));

const { getMcpToolDefinition, handleMcpToolCall, listMcpTools } =
  await import("@/api/mcp/tools");

const parseToolPayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
) => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text) as unknown;
};

const createScopedDb = (templates: unknown[] = []) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(
      async (
        callback: (tx: {
          query: { templates: { findMany: () => Promise<unknown[]> } };
        }) => unknown,
      ) =>
        await callback({
          query: { templates: { findMany: async () => templates } },
        }),
    ),
  );

const createContext = ({
  memberRole = "owner",
  scopedDb = createScopedDb(),
}: {
  memberRole?: McpRequestContext["memberRole"];
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: [toSafeId<"workspace">("ws_1")],
  accessibleWorkspaceIdSet: new Set(["ws_1"]),
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  ),
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
});

describe("MCP template tools", () => {
  beforeEach(() => {
    describeStoredTemplateMock.mockReset();
    fillStoredTemplateWithTextMock.mockReset();
    createStoredTemplateMock.mockReset();
    validateDocxBufferMock.mockReset();
    loadOrgAIConfigMock.mockReset();
    loadOrgAIConfigMock.mockResolvedValue(null);
    captureErrorMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("registers the template tools under the templates scope", async () => {
    const names = (await listMcpTools(createContext())).map(
      (tool) => tool.name,
    );
    expect(names).toContain("list_templates");
    expect(names).toContain("describe_template");
    expect(names).toContain("fill_template");
    expect(names).toContain("create_template");
    expect(names).toContain("template_marker_reference");

    for (const name of [
      "list_templates",
      "describe_template",
      "fill_template",
      "create_template",
      "template_marker_reference",
    ]) {
      expect((await getMcpToolDefinition(name, createContext()))?.scope).toBe(
        "stella:templates",
      );
    }
  });

  test("template tools are absent from anonymized mode", async () => {
    const names = (await listMcpTools(createContext(), "anonymized")).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain("list_templates");
    expect(names).not.toContain("create_template");
    expect(names).not.toContain("template_marker_reference");
  });

  test("template_marker_reference covers every canonical directive kind", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: "template_marker_reference",
    });

    expect(result.isError).toBeFalsy();
    const payload = parseToolPayload(result);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("reference" in payload) ||
      typeof payload.reference !== "string"
    ) {
      throw new Error("Expected a { reference: string } payload");
    }
    const { reference } = payload;

    // Every canonical directive kind from markers.ts must be documented, so the
    // reference can never silently drift from the grammar.
    for (const kind of DIRECTIVE_KINDS) {
      expect(reference).toContain(kind);
    }

    // The create_template description points agents at this tool first.
    const createTemplate = await getMcpToolDefinition(
      "create_template",
      createContext(),
    );
    expect(createTemplate?.description).toContain("template_marker_reference");
  });

  test("template_marker_reference rejects unexpected arguments", async () => {
    const result = await handleMcpToolCall({
      args: { unexpected: true },
      context: createContext(),
      toolName: "template_marker_reference",
    });

    expect(result.isError).toBe(true);
  });

  test("list_templates returns the org's templates", async () => {
    const rows = [
      {
        id: "t1",
        name: "NDA",
        fieldCount: 4,
        tags: ["nda"],
        whenToUse: "Use for NDAs",
        whenNotToUse: null,
      },
    ];
    const result = await handleMcpToolCall({
      args: {},
      context: createContext({ scopedDb: createScopedDb(rows) }),
      toolName: "list_templates",
    });
    expect(parseToolPayload(result)).toEqual({ templates: rows });
  });

  test("describe_template surfaces field hints and lookup formats", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      name: "Company POA",
      fields: [
        {
          path: "company",
          label: "Company",
          inputType: "text",
          required: true,
          hint: "Enter the KRS number",
          formats: [{ key: "default", template: "[name], KRS [krs]" }],
        },
      ],
      conditions: [{ name: "isCorp", expression: "type == 'corp'" }],
      computed: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1" },
      context: createContext(),
      toolName: "describe_template",
    });

    expect(describeStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "t1" }),
    );
    expect(parseToolPayload(result)).toMatchObject({
      name: "Company POA",
      fields: [
        expect.objectContaining({
          hint: "Enter the KRS number",
          formats: [{ key: "default", template: "[name], KRS [krs]" }],
        }),
      ],
    });
  });

  test("describe_template maps a service error to an MCP error", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      error: "Template not found.",
    });

    const result = await handleMcpToolCall({
      args: { template_id: "missing" },
      context: createContext(),
      toolName: "describe_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Template not found." },
    ]);
  });

  test("fill_template returns rendered text plus the DOCX as base64", async () => {
    const docxBytes = Buffer.from("PK filled docx bytes");
    fillStoredTemplateWithTextMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: docxBytes,
      text: "Lease between ACME and Tenant.",
      unmatchedPlaceholders: ["landlord.signature"],
      unusedValues: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1", values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(fillStoredTemplateWithTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "t1",
        values: { "tenant.name": "ACME" },
        organizationId: toSafeId<"organization">("org_1"),
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      templateName: "Lease",
      fileName: "lease.docx",
      text: "Lease between ACME and Tenant.",
      truncated: false,
      docxBase64: docxBytes.toString("base64"),
      unmatchedPlaceholders: ["landlord.signature"],
      unusedValues: [],
    });
  });

  test("create_template validates the DOCX and returns the new template id", async () => {
    validateDocxBufferMock.mockResolvedValue({ valid: true });
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({
        id: "tmpl_new",
        name: "NDA",
        fieldCount: 3,
      });
    });

    const docxBase64 = Buffer.from("PK docx").toString("base64");
    const result = await handleMcpToolCall({
      args: { name: "NDA", docx_base64: docxBase64 },
      context: createContext(),
      toolName: "create_template",
    });

    expect(validateDocxBufferMock).toHaveBeenCalledTimes(1);
    expect(createStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "NDA",
        fileName: "NDA.docx",
        organizationId: toSafeId<"organization">("org_1"),
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      templateId: "tmpl_new",
      name: "NDA",
      fieldCount: 3,
    });
  });

  test("create_template rejects an invalid DOCX before inserting", async () => {
    validateDocxBufferMock.mockResolvedValue({
      valid: false,
      error: "Missing word/document.xml",
    });

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: Buffer.from("not a docx").toString("base64"),
      },
      context: createContext(),
      toolName: "create_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("create_template forbids members without template:create permission", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: Buffer.from("PK").toString("base64"),
      },
      context: createContext({ memberRole: "intern" }),
      toolName: "create_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Forbidden" }]);
    expect(validateDocxBufferMock).not.toHaveBeenCalled();
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });
});
