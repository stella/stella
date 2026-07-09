import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const describeStoredTemplateMock = mock();
const fillStoredTemplateWithTextMock = mock();
const createStoredTemplateMock = mock();
const recordTemplateFillMock = mock();
const configureTemplateFieldsMock = mock();
const loadOrgAIConfigMock = mock();
const captureErrorMock = mock();
const anonymizeTextFieldsMock = mock();
const loadAnonymizationGazetteerEntriesMock = mock();
const realAnonymizationBlacklist =
  await import("@/api/lib/anonymization-blacklist");

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: () => ({ capture: mock(), flush: mock(async () => undefined) }),
}));

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/lib/anonymization-blacklist", () => ({
  ...realAnonymizationBlacklist,
  loadAnonymizationGazetteerEntries: loadAnonymizationGazetteerEntriesMock,
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

void mock.module("@/api/handlers/templates/record-use", () => ({
  recordTemplateFill: recordTemplateFillMock,
  recordTemplateUse: mock(),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The parsed `error` object of a structured `{ error: { code, message,
// issues? } }` validation envelope.
const validationEnvelope = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): Record<string, unknown> => {
  const payload = parseToolPayload(result);
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    throw new Error("expected a structured error envelope");
  }
  return payload["error"];
};

const createScopedDb = (templates: unknown[] = []) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(async (run: (tx: unknown) => unknown) => {
      // list_templates now uses the core query builder; the chain ignores its
      // column/where/order arguments and resolves to the seeded rows.
      const builder = {
        select: () => builder,
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: async () => templates,
      };
      return await run({
        ...builder,
        query: { templates: { findMany: async () => templates } },
      });
    }),
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
  accessibleWorkspaceStatusById: new Map([["ws_1", "active"]]),
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
 *  save_template (create) exercises the real validateDocxBuffer — no module mock to
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
    recordTemplateFillMock.mockReset();
    configureTemplateFieldsMock.mockReset();
    loadOrgAIConfigMock.mockReset();
    loadOrgAIConfigMock.mockResolvedValue(null);
    captureErrorMock.mockReset();
    anonymizeTextFieldsMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockReset();
    loadAnonymizationGazetteerEntriesMock.mockResolvedValue([]);
  });

  afterAll(() => {
    mock.restore();
  });

  test("registers the template tools under the templates scope", async () => {
    const names = (await listMcpTools(createContext())).map(
      (tool) => tool.name,
    );
    // list_templates absorbed describe_template (M2); save_template absorbed
    // create_template + configure_template_fields (M3); template_marker_reference
    // moved to an MCP resource (M5).
    expect(names).toContain("list_templates");
    expect(names).toContain("fill_template");
    expect(names).toContain("save_template");
    expect(names).not.toContain("describe_template");
    expect(names).not.toContain("create_template");
    expect(names).not.toContain("configure_template_fields");
    expect(names).not.toContain("template_marker_reference");

    for (const name of ["list_templates", "fill_template", "save_template"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-tool assertion; keeps the failing tool name obvious in test output
      expect((await getMcpToolDefinition(name, createContext()))?.scope).toBe(
        "stella:templates",
      );
    }
  });

  test("the read template tool is on the anonymized surface; writes are not", async () => {
    const names = (await listMcpTools(createContext(), "anonymized")).map(
      (tool) => tool.name,
    );
    // list_templates (list + detail) is projected (anonymized); the mutating
    // tools stay off the egress-only surface.
    expect(names).toContain("list_templates");
    expect(names).not.toContain("fill_template");
    expect(names).not.toContain("save_template");
  });

  test("the projected template tool carries the anonymized templates scope", async () => {
    const definition = await getMcpToolDefinition(
      "list_templates",
      createContext(),
      "anonymized",
    );
    expect(definition?.scope).toBe("stella:templates_anonymized");
  });

  test("save_template's description points to the marker reference resource", async () => {
    const saveTemplate = await getMcpToolDefinition(
      "save_template",
      createContext(),
    );
    expect(saveTemplate?.description).toContain(
      "template-markers reference resource",
    );
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
    expect(parseToolPayload(result)).toEqual({
      templates: rows,
      nextCursor: null,
    });
  });

  test("list_templates anonymizes template tags in anonymized mode", async () => {
    const rows = [
      {
        id: "t1",
        name: "Smith NDA",
        fieldCount: 4,
        tags: ["Smith acquisition"],
        whenToUse: "Use for Smith acquisition",
        whenNotToUse: null,
      },
    ];
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 3,
      fields: ["[MATTER_1] NDA", "Use for [MATTER_1]", "[MATTER_1]"],
    });

    const result = await handleMcpToolCall({
      args: {},
      context: createContext({ scopedDb: createScopedDb(rows) }),
      mode: "anonymized",
      toolName: "list_templates",
    });

    expect(parseToolPayload(result)).toEqual({
      templates: [
        {
          ...rows[0],
          name: "[MATTER_1] NDA",
          tags: ["[MATTER_1]"],
          whenToUse: "Use for [MATTER_1]",
        },
      ],
      nextCursor: null,
    });
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: ["Smith NDA", "Use for Smith acquisition", "Smith acquisition"],
      workspaceId: "org_1",
    });
  });

  test("list_templates (detail) surfaces the full field config for round-tripping", async () => {
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
          inputType: "text",
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
      toolName: "list_templates",
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

  test("list_templates (detail) anonymizes nested field option text", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      name: "Smith POA",
      fields: [
        {
          path: "role",
          label: "Smith role",
          inputType: "select",
          options: ["Smith director"],
          parts: [
            {
              key: "capacity",
              label: "Smith capacity",
              inputType: "select",
              options: ["Smith signatory"],
            },
          ],
          formats: [
            { key: "default", template: "[company name], Smith registry" },
          ],
        },
      ],
      conditions: [],
      computed: [],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 6,
      fields: [
        "[PERSON_1] POA",
        "[PERSON_1] role",
        "[PERSON_1] director",
        "[PERSON_1] capacity",
        "[PERSON_1] signatory",
        "[company name], [PERSON_1] registry",
      ],
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1" },
      context: createContext(),
      mode: "anonymized",
      toolName: "list_templates",
    });

    expect(parseToolPayload(result)).toMatchObject({
      name: "[PERSON_1] POA",
      fields: [
        {
          label: "[PERSON_1] role",
          options: ["[PERSON_1] director"],
          parts: [
            {
              label: "[PERSON_1] capacity",
              options: ["[PERSON_1] signatory"],
            },
          ],
          formats: [
            {
              template: "[company name], [PERSON_1] registry",
            },
          ],
        },
      ],
    });
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: [
        "Smith POA",
        "Smith role",
        "Smith director",
        "Smith capacity",
        "Smith signatory",
        "[company name], Smith registry",
      ],
      workspaceId: "org_1",
    });
  });

  test("list_templates (detail) maps a service error to an MCP error", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      error: "Template not found.",
    });

    const result = await handleMcpToolCall({
      args: { template_id: "missing" },
      context: createContext(),
      toolName: "list_templates",
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
    // The execution is recorded (fill row + audit) so agent fills are audited.
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "t1",
        organizationId: toSafeId<"organization">("org_1"),
        format: "docx",
        unmatchedCount: 1,
        unusedCount: 0,
      }),
    );
  });

  test("fill_template surfaces an AI usage rejection as an error", async () => {
    // The fill service runs the usage preflight only when the template declares
    // AI fields; an over-quota org gets a rejection the MCP tool surfaces
    // instead of spending model calls.
    fillStoredTemplateWithTextMock.mockResolvedValue({
      usageRejection: { message: "Monthly AI usage limit reached." },
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1", values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Monthly AI usage limit reached." },
    ]);
  });

  test("save_template (create) validates the DOCX and returns the new template id", async () => {
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
      toolName: "save_template",
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

  test("save_template (create) rejects an invalid DOCX before inserting", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: Buffer.from("not a docx").toString("base64"),
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) forbids members without template:create permission", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: Buffer.from("PK").toString("base64"),
      },
      context: createContext({ memberRole: "intern" }),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Forbidden" }]);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) passes a validated fields overlay (incl. a lookup field) to the service", async () => {
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
      toolName: "save_template",
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

  test("save_template (create) rejects a malformed field config before inserting", async () => {
    const docxBase64 = await makeValidDocxBase64();

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: docxBase64,
        // formula is mutually exclusive with aiPrompt, so isFieldMeta rejects it.
        fields: [{ path: "fee", formula: "rent * 12", aiPrompt: "draft it" }],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("fields[0]");
  });

  test("save_template (create) surfaces the service's unknown-path rejection", async () => {
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
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("ghost");
  });

  test("save_template (configure) applies the overlay and returns the updated fields", async () => {
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
      toolName: "save_template",
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
    // The tool echoes the list_templates detail shape so detail → configure round-trips.
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

  test("save_template (configure) rejects a config whose path is unknown", async () => {
    configureTemplateFieldsMock.mockImplementation(async function* () {
      yield* [];
      return Result.err({
        message: 'No field "ghost" in this template.',
      });
    });

    const result = await handleMcpToolCall({
      args: { template_id: "t1", fields: [{ path: "ghost", label: "Ghost" }] },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(describeStoredTemplateMock).not.toHaveBeenCalled();
    const message = result.content.at(0);
    expect(message?.type === "text" && message.text).toContain("ghost");
  });

  test("save_template (configure) forbids members without template:create permission", async () => {
    const result = await handleMcpToolCall({
      args: { template_id: "t1", fields: [{ path: "company" }] },
      context: createContext({ memberRole: "intern" }),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Forbidden" }]);
    expect(configureTemplateFieldsMock).not.toHaveBeenCalled();
  });

  test("list_templates (detail) rejects template_id combined with a cursor", async () => {
    const result = await handleMcpToolCall({
      args: { template_id: "t1", cursor: "abc" },
      context: createContext(),
      toolName: "list_templates",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "cursor applies when listing templates; omit template_id to list",
        },
      ],
      isError: true,
    });
    expect(describeStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template rejects a request with neither docx_base64 nor template_id", async () => {
    const result = await handleMcpToolCall({
      args: { name: "NDA" },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Provide docx_base64 to create a template, or template_id to configure an existing template's fields",
    );
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    expect(configureTemplateFieldsMock).not.toHaveBeenCalled();
  });
});
