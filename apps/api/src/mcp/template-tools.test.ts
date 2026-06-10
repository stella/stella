import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import { DIRECTIVE_KINDS } from "@stll/template-conditions";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const describeStoredTemplateMock = mock();
const fillStoredTemplateWithTextMock = mock();
const createStoredTemplateMock = mock();
const configureTemplateFieldsMock = mock();
const loadOrgAIConfigMock = mock();
const captureErrorMock = mock();

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: () => ({ capture: mock(), flush: mock(async () => undefined) }),
}));

// Stub every export this service has, not only the two the MCP tools use, so
// the module mock stays complete when another test file that imports the other
// fill helpers (e.g. the chat template tools) is run in the same process.
void mock.module("@/api/handlers/templates/template-fill-service", () => ({
  describeStoredTemplate: describeStoredTemplateMock,
  fillStoredTemplateWithText: fillStoredTemplateWithTextMock,
  fillStoredTemplate: mock(),
  fillStoredTemplateDocx: mock(),
}));

void mock.module("@/api/handlers/templates/create-template-service", () => ({
  createStoredTemplate: createStoredTemplateMock,
}));

void mock.module(
  "@/api/handlers/templates/configure-template-fields-service",
  () => ({
    configureTemplateFields: configureTemplateFieldsMock,
  }),
);

// Stubbed so the fill handler never reaches the real (DB-backed) config
// loader or AI model chain; a null config makes AI fields a no-op.
// A null org AI config (the mock returns undefined) makes the real
// ai-field-generator builders return undefined, so AI fields/conditions are a
// no-op without mocking the generator module — which would bleed process-wide
// into ai-field-generator.test.ts (Bun's mock.module is global).
void mock.module("@/api/lib/ai-config-loader", () => ({
  loadOrgAIConfig: loadOrgAIConfigMock,
  loadPromptCachingPreference: mock(async () => false),
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

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A real, minimal valid DOCX (well-formed word/document.xml) as base64, so
 *  create_template exercises the real validateDocxBuffer — no module mock to
 *  leak across test files. */
const makeValidDocxBase64 = async (): Promise<string> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>{{name}}</w:t></w:r></w:p></w:body></w:document>`,
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return Buffer.from(bytes).toString("base64");
};

describe("MCP template tools", () => {
  beforeEach(() => {
    describeStoredTemplateMock.mockReset();
    fillStoredTemplateWithTextMock.mockReset();
    createStoredTemplateMock.mockReset();
    configureTemplateFieldsMock.mockReset();
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
    expect(names).toContain("configure_template_fields");
    expect(names).toContain("template_marker_reference");

    for (const name of [
      "list_templates",
      "describe_template",
      "fill_template",
      "create_template",
      "configure_template_fields",
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
    expect(names).not.toContain("configure_template_fields");
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

  test("describe_template surfaces the full field config for round-tripping", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      name: "Company POA",
      fields: [
        {
          path: "company",
          label: "Company",
          inputType: "text",
          required: true,
          hint: "Enter the KRS number",
          options: null,
          formats: [{ key: "default", template: "[name], KRS [krs]" }],
          aiPrompt: null,
          aiAdapt: false,
          optionsFrom: null,
          dateFormat: null,
          parts: null,
          format: null,
        },
        {
          path: "scope",
          label: "Scope",
          inputType: "textarea",
          required: false,
          hint: null,
          options: null,
          formats: null,
          aiPrompt: "Draft the scope of this power of attorney",
          aiAdapt: false,
          optionsFrom: null,
          dateFormat: null,
          parts: null,
          format: null,
        },
        {
          path: "role",
          label: "Role",
          inputType: "select",
          required: false,
          hint: null,
          options: ["director", "proxy"],
          formats: null,
          aiPrompt: null,
          aiAdapt: false,
          optionsFrom: "parties",
          dateFormat: null,
          parts: null,
          format: null,
        },
      ],
      conditions: [{ name: "isCorp", expression: "type == 'corp'" }],
      computed: [{ name: "total", expression: "rent * 12" }],
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
        expect.objectContaining({
          aiPrompt: "Draft the scope of this power of attorney",
        }),
        expect.objectContaining({
          options: ["director", "proxy"],
          optionsFrom: "parties",
        }),
      ],
      computed: [{ name: "total", expression: "rent * 12" }],
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
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({
        id: "tmpl_new",
        name: "NDA",
        fieldCount: 3,
      });
    });

    const docxBase64 = await makeValidDocxBase64();
    const result = await handleMcpToolCall({
      args: { name: "NDA", docx_base64: docxBase64 },
      context: createContext(),
      toolName: "create_template",
    });

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
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("create_template passes a validated fields overlay (incl. a lookup field) to the service", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_new", name: "Company POA", fieldCount: 1 });
    });

    const result = await handleMcpToolCall({
      args: {
        name: "Company POA",
        docx_base64: await makeValidDocxBase64(),
        fields: [
          {
            path: "company",
            label: "Company",
            inputType: "text",
            required: true,
            lookup: {
              registry: "krs",
              formats: [
                { key: "default", template: "[name], KRS [krs]" },
                { key: "address", template: "[seat]" },
              ],
            },
          },
        ],
      },
      context: createContext(),
      toolName: "create_template",
    });

    expect(result.isError).toBeFalsy();
    expect(createStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientManifest: {
          fields: [
            expect.objectContaining({
              path: "company",
              lookup: {
                registry: "krs",
                formats: [
                  { key: "default", template: "[name], KRS [krs]" },
                  { key: "address", template: "[seat]" },
                ],
              },
            }),
          ],
        },
      }),
    );
  });

  test("create_template rejects a malformed field config before inserting", async () => {
    const docxBase64 = await makeValidDocxBase64();

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: docxBase64,
        // formula is mutually exclusive with aiPrompt, so isFieldMeta rejects it.
        fields: [{ path: "fee", formula: "rent * 12", aiPrompt: "draft it" }],
      },
      context: createContext(),
      toolName: "create_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("fields[0]");
  });

  test("create_template surfaces the service's unknown-path rejection", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.err({
        message: 'No field "ghost" was discovered in the DOCX.',
      });
    });

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        fields: [{ path: "ghost", label: "Ghost" }],
      },
      context: createContext(),
      toolName: "create_template",
    });

    expect(result.isError).toBe(true);
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("ghost");
  });

  test("configure_template_fields applies the overlay and returns the updated fields", async () => {
    configureTemplateFieldsMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({
        manifest: { version: 1, fields: [] },
      });
    });
    describeStoredTemplateMock.mockResolvedValue({
      name: "Company POA",
      fields: [
        {
          path: "company",
          label: "Company",
          inputType: "text",
          required: true,
          hint: null,
          options: null,
          formats: [{ key: "default", template: "[name], KRS [krs]" }],
          aiPrompt: null,
          aiAdapt: false,
          optionsFrom: null,
          dateFormat: null,
          parts: null,
          format: null,
        },
      ],
      conditions: [],
      computed: [],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: "t1",
        fields: [
          {
            path: "company",
            lookup: {
              registry: "krs",
              formats: [{ key: "default", template: "[name], KRS [krs]" }],
            },
          },
        ],
      },
      context: createContext(),
      toolName: "configure_template_fields",
    });

    expect(result.isError).toBeFalsy();
    expect(configureTemplateFieldsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "t1",
        organizationId: toSafeId<"organization">("org_1"),
        fields: [
          expect.objectContaining({
            path: "company",
            lookup: expect.objectContaining({ registry: "krs" }),
          }),
        ],
      }),
    );
    // The tool echoes describe_template's shape so describe → configure round-trips.
    expect(parseToolPayload(result)).toMatchObject({
      name: "Company POA",
      fields: [
        expect.objectContaining({
          path: "company",
          formats: [{ key: "default", template: "[name], KRS [krs]" }],
        }),
      ],
    });
    expect(describeStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "t1" }),
    );
  });

  test("configure_template_fields rejects a config whose path is unknown", async () => {
    configureTemplateFieldsMock.mockImplementation(async function* () {
      yield* [];
      return Result.err({
        message: 'No field "ghost" in this template.',
      });
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1", fields: [{ path: "ghost", label: "Ghost" }] },
      context: createContext(),
      toolName: "configure_template_fields",
    });

    expect(result.isError).toBe(true);
    expect(describeStoredTemplateMock).not.toHaveBeenCalled();
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("ghost");
  });

  test("configure_template_fields forbids members without template:create permission", async () => {
    const result = await handleMcpToolCall({
      args: { template_id: "t1", fields: [{ path: "company" }] },
      context: createContext({ memberRole: "intern" }),
      toolName: "configure_template_fields",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Forbidden" }]);
    expect(configureTemplateFieldsMock).not.toHaveBeenCalled();
  });
});
