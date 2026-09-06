import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import JSZip from "jszip";

import type { Transaction } from "@/api/db/root";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MAX_ENTRIES } from "@/api/lib/docx-archive";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { CONTACT_FIELDS } from "@/api/lib/template-binding/binding-sources";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { TEMPLATE_FIELD_REFERENCE_URI } from "@/api/mcp/template-field-reference";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const describeStoredTemplateMock = mock();
const fillStoredTemplateDocxMock = mock();
const fillStoredTemplateWithTextMock = mock();
const fillStoredTemplateWithTextStrictMock = mock();
const createEntityFromBufferMock = mock();
const createEntityVersionFromBufferMock = mock();
const createStoredTemplateMock = mock();
const safeOutboundFetchBytesMock = mock();
const recordTemplateFillMock = mock();
const recordTemplateUseMock = mock();
const claimTemplatePersistenceRequestMock = mock();
const recordTemplatePersistenceReceiptMock = mock();
const releaseTemplatePersistenceClaimMock = mock();
const fingerprintTemplatePersistenceRequestMock = mock();
const configureTemplateFieldsMock = mock();
const loadOrgAIConfigMock = mock();
const anonymizeTextFieldsMock = mock();
/** Empty catalogs, one entry per requested id, like the real loaders. */
const emptyCatalogsByWorkspace = async ({
  workspaceIds,
}: {
  workspaceIds: readonly string[];
}) =>
  await Promise.resolve(
    new Map(workspaceIds.map((workspaceId) => [workspaceId, []])),
  );
// Stubbed so the fill handler never reaches the real (DB-backed) config
// loader or AI model chain; a null config makes AI fields a no-op.
// A null org AI config (the mock returns undefined) makes the real
// ai-field-generator builders return undefined, so AI fields/conditions are a
// no-op without mocking the generator module — which would bleed process-wide
// into ai-field-generator.test.ts (Bun's mock.module is global).

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

/** One property of the advertised `fields` overlay item schema. */
const fieldOverlayProperty = (schema: unknown, property: string): unknown => {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  const fields = isRecord(properties) ? properties["fields"] : undefined;
  const items = isRecord(fields) ? fields["items"] : undefined;
  const itemProperties = isRecord(items) ? items["properties"] : undefined;
  return isRecord(itemProperties) ? itemProperties[property] : undefined;
};

/** The `field` enum of one `source` union branch. */
const fieldEnum = (branch: unknown): unknown => {
  const properties = isRecord(branch) ? branch["properties"] : undefined;
  const field = isRecord(properties) ? properties["field"] : undefined;
  return isRecord(field) ? field["enum"] : undefined;
};

/** Walks an advertised schema and records the path of every object level (at
 *  any depth, including array items and union branches) that does not close
 *  its property set. */
const collectOpenObjectPaths = (
  schema: unknown,
  path: string,
  open: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (schema["type"] === "object" && schema["additionalProperties"] !== false) {
    open.push(path);
  }
  const properties = schema["properties"];
  if (isRecord(properties)) {
    for (const [key, property] of Object.entries(properties)) {
      collectOpenObjectPaths(property, `${path}.${key}`, open);
    }
  }
  collectOpenObjectPaths(schema["items"], `${path}[]`, open);
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    for (const [index, branch] of branches.entries()) {
      collectOpenObjectPaths(branch, `${path}|${index}`, open);
    }
  }
};

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

type SeededEntityTarget =
  | {
      currentVersionId: string;
      readOnly: boolean;
      currentVersion: { fields: { content: { type: string } }[] };
    }
  | { kind: "folder" | "document" }
  | null;

const createScopedDb = (
  templates: unknown[] = [],
  entityTargets: Record<string, SeededEntityTarget> = {},
  entityCount = 0,
) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(async (run: (tx: unknown) => unknown) => {
      // list_templates now uses the core query builder; the chain ignores its
      // column/where/order arguments and resolves to the seeded rows.
      const builder = {
        select: () => builder,
        from: () => builder,
        // The gateway connector load joins two tables; model the step so its
        // read resolves to the (empty by default) seed instead of erroring.
        innerJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: async () => templates,
      };
      return await run({
        ...builder,
        $count: async () => entityCount,
        query: {
          entities: {
            findFirst: async ({ where }: { where: { id: { eq: string } } }) => {
              const id = where.id.eq;
              if (Object.hasOwn(entityTargets, id)) {
                return entityTargets[id];
              }
              if (id === FOLDER_ID) {
                return { kind: "folder" };
              }
              return {
                currentVersionId: "version_1",
                readOnly: false,
                currentVersion: {
                  fields: [{ content: { type: "file" } }],
                },
              };
            },
          },
          templates: { findMany: async () => templates },
          // No settings row: a brand-new org with no practice jurisdictions,
          // which is exactly when a registry lookup is not enabled.
          organizationSettings: { findFirst: async () => undefined },
        },
      });
    }),
  );

const createContext = ({
  memberRole = "owner",
  scopedDb = createScopedDb(),
  workspaceStatus = "active",
}: {
  memberRole?: McpRequestContext["memberRole"];
  scopedDb?: McpRequestContext["scopedDb"];
  workspaceStatus?: "active" | "archived";
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
  accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
  accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, workspaceStatus]]),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole,
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent: asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  ),
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  userId: toSafeId<"user">("user_1"),
  testDependencies: {
    describeStoredTemplate: describeStoredTemplateMock,
    fillStoredTemplateDocx: fillStoredTemplateDocxMock,
    fillStoredTemplateWithText: fillStoredTemplateWithTextMock,
    fillStoredTemplateWithTextStrict: fillStoredTemplateWithTextStrictMock,
    createStoredTemplate: createStoredTemplateMock,
    safeOutboundFetchBytes: safeOutboundFetchBytesMock,
    recordTemplateFill: recordTemplateFillMock,
    recordTemplateUse: recordTemplateUseMock,
    claimTemplatePersistenceRequest: claimTemplatePersistenceRequestMock,
    fingerprintTemplatePersistenceRequest:
      fingerprintTemplatePersistenceRequestMock,
    persistFilledTemplateDocument: createEntityFromBufferMock,
    persistFilledTemplateVersion: createEntityVersionFromBufferMock,
    recordTemplatePersistenceReceipt: recordTemplatePersistenceReceiptMock,
    releaseTemplatePersistenceClaim: releaseTemplatePersistenceClaimMock,
    configureTemplateFields: configureTemplateFieldsMock,
    loadOrgAIConfig: loadOrgAIConfigMock,
    anonymizeTextFields: anonymizeTextFieldsMock,
    loadAnonymizationAllowlistCanonicalsByWorkspace: emptyCatalogsByWorkspace,
    loadAnonymizationGazetteerEntriesByWorkspace: emptyCatalogsByWorkspace,
  },
});

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000000";
const ENTITY_ID = "00000000-0000-4000-8000-000000000001";
const FOLDER_ID = "00000000-0000-4000-8000-000000000002";
const MISSING_FOLDER_ID = "00000000-0000-4000-8000-000000000003";
const NON_FOLDER_ID = "00000000-0000-4000-8000-000000000004";
const MISSING_VERSION_ID = "00000000-0000-4000-8000-000000000005";
const READ_ONLY_VERSION_ID = "00000000-0000-4000-8000-000000000006";
const NON_FILE_VERSION_ID = "00000000-0000-4000-8000-000000000007";
const MISSING_TEMPLATE_ID = "00000000-0000-4000-8000-000000000008";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000009";
const fakeTransaction = asTestRaw<Transaction>({});

/** A real, minimal valid DOCX (well-formed word/document.xml) as base64, so
 *  save_template (create) exercises the real validateDocxBuffer — no module mock to
 *  leak across test files. */
const makeValidDocxBytes = async (
  paragraphs: readonly string[] = ["{{name}}"],
): Promise<Uint8Array> => {
  const zip = new JSZip();
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`,
  );
  return await zip.generateAsync({ type: "uint8array" });
};

const makeValidDocxBase64 = async (
  paragraphs: readonly string[] = ["{{name}}"],
): Promise<string> =>
  Buffer.from(await makeValidDocxBytes(paragraphs)).toString("base64");

/** A host file reference pointing at `bytes`, as an MCP host would supply. */
const hostFileResponse = (bytes: Uint8Array) =>
  Result.ok({
    body: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
    headers: new Headers(),
    ok: true,
    status: 200,
  });

const HOST_FILE_REFERENCE = {
  download_url: "https://files.example/nda.docx",
  file_id: "file_nda",
  file_name: "nda.docx",
  mime_type:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** A real DOCX carrying the given paragraphs, so a fill whose result is read
 *  back through the shared extractor runs the real reader instead of a stub. */
const makeDocxBuffer = async (paragraphs: string[]): Promise<Buffer> => {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
};

describe("MCP template tools", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    describeStoredTemplateMock.mockReset();
    fillStoredTemplateDocxMock.mockReset();
    fillStoredTemplateWithTextMock.mockReset();
    fillStoredTemplateWithTextStrictMock.mockReset();
    createEntityFromBufferMock.mockReset();
    createEntityVersionFromBufferMock.mockReset();
    createStoredTemplateMock.mockReset();
    safeOutboundFetchBytesMock.mockReset();
    recordTemplateFillMock.mockReset();
    recordTemplateUseMock.mockReset();
    claimTemplatePersistenceRequestMock.mockReset();
    claimTemplatePersistenceRequestMock.mockResolvedValue(
      Result.ok({ status: "claimed", claimToken: "claim_1" }),
    );
    recordTemplatePersistenceReceiptMock.mockReset();
    recordTemplatePersistenceReceiptMock.mockResolvedValue(undefined);
    releaseTemplatePersistenceClaimMock.mockReset();
    releaseTemplatePersistenceClaimMock.mockResolvedValue(Result.ok(undefined));
    fingerprintTemplatePersistenceRequestMock.mockReset();
    fingerprintTemplatePersistenceRequestMock.mockReturnValue(
      "request-fingerprint",
    );
    configureTemplateFieldsMock.mockReset();
    loadOrgAIConfigMock.mockReset();
    loadOrgAIConfigMock.mockResolvedValue(null);
    anonymizeTextFieldsMock.mockReset();
  });

  afterEach(() => {
    analytics.restore();
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
    expect(names).toContain("save_filled_template");
    expect(names).toContain("save_template");
    expect(names).not.toContain("describe_template");
    expect(names).not.toContain("create_template");
    expect(names).not.toContain("configure_template_fields");
    expect(names).not.toContain("template_marker_reference");

    for (const name of ["list_templates", "fill_template", "save_template"]) {
      expect((await getMcpToolDefinition(name, createContext()))?.scope).toBe(
        "stella:templates",
      );
    }
    expect(
      (await getMcpToolDefinition("save_filled_template", createContext()))
        ?.scope,
    ).toBe("stella:documents_write");
    expect(
      (await getMcpToolDefinition("save_filled_template", createContext()))
        ?.additionalScopes,
    ).toEqual(["stella:templates"]);
  });

  test("the read template tool is on the anonymized surface; writes are not", async () => {
    const names = (await listMcpTools(createContext(), "anonymized")).map(
      (tool) => tool.name,
    );
    // list_templates (list + detail) is projected (anonymized); the mutating
    // tools stay off the egress-only surface.
    expect(names).toContain("list_templates");
    expect(names).not.toContain("fill_template");
    expect(names).not.toContain("save_filled_template");
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

  test("save_template's description names both reference resource URIs", async () => {
    const saveTemplate = await getMcpToolDefinition(
      "save_template",
      createContext(),
    );
    // The grammar and the per-property field guidance stay in the resources:
    // the description carries only the tool contract plus the URIs an agent
    // can read them from.
    expect(saveTemplate?.description).toContain(TEMPLATE_MARKER_REFERENCE_URI);
    expect(saveTemplate?.description).toContain(TEMPLATE_FIELD_REFERENCE_URI);
    expect(saveTemplate?.description).not.toContain("{{@clause:");
  });

  test("save_template advertises its host-file and inline limits, and forbids trimming the file to fit", async () => {
    const saveTemplate = await getMcpToolDefinition(
      "save_template",
      createContext(),
    );
    const enforcedMegabytes = Math.floor(
      FILE_SIZE_LIMIT_BYTES.document / (1024 * 1024),
    );
    const inlineDocxBytes = Math.floor(
      (Math.floor(MCP_MAX_REQUEST_BODY_BYTES / 2) / 4) * 3,
    );
    expect(saveTemplate?.description).toContain(
      `up to ${enforcedMegabytes} MB`,
    );
    expect(saveTemplate?.description).toContain(
      `max ${inlineDocxBytes} bytes decoded within the ${MCP_MAX_REQUEST_BODY_BYTES}-byte MCP request frame`,
    );
    expect(saveTemplate?.description).toContain(
      "never retype the file or strip parts out to fit",
    );
  });

  test("list_templates' description points at the field reference instead of listing its keys", async () => {
    const listTemplates = await getMcpToolDefinition(
      "list_templates",
      createContext(),
    );
    expect(listTemplates?.description).toContain(TEMPLATE_FIELD_REFERENCE_URI);
    expect(listTemplates?.description).not.toContain("options_from");
  });

  test("save_template advertises the fields overlay pointing at the resource", async () => {
    const saveTemplate = await getMcpToolDefinition(
      "save_template",
      createContext(),
    );
    const fields = saveTemplate?.inputSchema.properties?.["fields"];
    expect(isRecord(fields) ? fields["description"] : undefined).toContain(
      TEMPLATE_FIELD_REFERENCE_URI,
    );
  });

  test("save_template keeps the full source union and every contact field key", async () => {
    const saveTemplate = await getMcpToolDefinition(
      "save_template",
      createContext(),
    );
    const source = fieldOverlayProperty(saveTemplate?.inputSchema, "source");
    const branches = isRecord(source) ? source["anyOf"] : undefined;
    expect(Array.isArray(branches) ? branches.length : 0).toBe(5);
    // Moving the prose out must not narrow what the schema accepts: the
    // contact branch still enumerates every built-in contact field key.
    const contactBranch = Array.isArray(branches) ? branches.at(0) : undefined;
    expect(fieldEnum(contactBranch)).toEqual([...CONTACT_FIELDS]);
  });

  test("every template tool schema closes its objects, bar the free-form value maps", async () => {
    const openPaths: string[] = [];
    for (const name of [
      "list_templates",
      "fill_template",
      "save_filled_template",
      "save_template",
    ]) {
      const tool = await getMcpToolDefinition(name, createContext());
      collectOpenObjectPaths(tool?.inputSchema, name, openPaths);
    }
    // The two exceptions are the documented path-to-value maps, whose keys are
    // the template's own field paths.
    expect(openPaths.sort()).toEqual([
      "fill_template.values",
      "save_filled_template.values",
    ]);
  });

  test("list_templates returns the org's templates", async () => {
    const rows = [
      {
        id: TEMPLATE_ID,
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
        id: TEMPLATE_ID,
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
          lookup: {
            registry: "krs",
            formats: [{ key: "default", template: "[name], KRS [krs]" }],
          },
          validation: { required: true },
          source: null,
          aiSeesDocument: false,
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
          lookup: null,
          validation: null,
          source: null,
          aiSeesDocument: true,
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
          lookup: null,
          validation: null,
          source: { kind: "party", role: "counterparty", field: "name" },
          aiSeesDocument: false,
          aiPrompt: null,
          aiAdapt: false,
          optionsFrom: "parties",
          dateFormat: null,
          parts: null,
          format: null,
        },
      ],
      conditions: [{ path: "isCorp", condition: "type == 'corp'" }],
      computed: [{ path: "total", formula: "rent * 12" }],
      arrays: [{ path: "deliverables", itemFieldPaths: ["name", "due_date"] }],
      warnings: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID },
      context: createContext(),
      toolName: "list_templates",
    });

    expect(describeStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: TEMPLATE_ID }),
    );
    expect(parseToolPayload(result)).toMatchObject({
      name: "Company POA",
      fields: [
        expect.objectContaining({
          hint: "Enter the KRS number",
          // The whole lookup, registry included, in the shape the `fields`
          // overlay accepts: read, edit, send back.
          lookup: {
            registry: "krs",
            formats: [{ key: "default", template: "[name], KRS [krs]" }],
          },
          validation: { required: true },
        }),
        expect.objectContaining({
          ai_prompt: "Draft the scope of this power of attorney",
          ai_sees_document: true,
        }),
        expect.objectContaining({
          options: ["director", "proxy"],
          options_from: "parties",
          source: { kind: "party", role: "counterparty", field: "name" },
        }),
      ],
      computed: [{ path: "total", formula: "rent * 12" }],
      // A `{{#each}}` loop over object items is surfaced separately from the
      // flat `fields` list so a caller knows to submit it as an array.
      arrays: [{ path: "deliverables", itemFieldPaths: ["name", "due_date"] }],
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
          lookup: {
            registry: "krs",
            formats: [
              { key: "default", template: "[company name], Smith registry" },
            ],
          },
        },
      ],
      conditions: [],
      computed: [],
      warnings: [
        {
          code: "split_marker",
          path: "{{Smith.name}}",
          message: "{{Smith.name}} is split across runs.",
          hint: "Retype {{Smith.name}} in one run.",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 9,
      fields: [
        "[PERSON_1] POA",
        "[PERSON_1] role",
        "[PERSON_1] director",
        "[PERSON_1] capacity",
        "[PERSON_1] signatory",
        "[company name], [PERSON_1] registry",
        "{{[PERSON_1].name}}",
        "{{[PERSON_1].name}} is split across runs.",
        "Retype {{[PERSON_1].name}} in one run.",
      ],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID },
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
          lookup: {
            formats: [
              {
                template: "[company name], [PERSON_1] registry",
              },
            ],
          },
        },
      ],
      warnings: [
        {
          path: "{{[PERSON_1].name}}",
          message: "{{[PERSON_1].name}} is split across runs.",
          hint: "Retype {{[PERSON_1].name}} in one run.",
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
        "{{Smith.name}}",
        "{{Smith.name}} is split across runs.",
        "Retype {{Smith.name}} in one run.",
      ],
      workspaceId: "org_1",
    });
  });

  test("list_templates (detail) maps a service error to an MCP error", async () => {
    describeStoredTemplateMock.mockResolvedValue({
      error: "Template not found.",
    });

    const result = await handleMcpToolCall({
      args: { template_id: MISSING_TEMPLATE_ID },
      context: createContext(),
      toolName: "list_templates",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Template not found." },
    ]);
    // A curated service rejection reaches the agent as-is; it is not a defect,
    // so it must not spend an exception event.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("fill_template returns a complete rendered document plus the DOCX as base64 under output=docx", async () => {
    const docxBytes = Buffer.from("PK filled docx bytes");
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: docxBytes,
      text: "Lease between ACME and Tenant.",
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [
        {
          directive: "#if signature",
          message: "Missing closing directive",
          paragraphIndex: 4,
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        values: { "tenant.name": "ACME" },
        output_mode: "docx",
      },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(fillStoredTemplateWithTextStrictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        values: { "tenant.name": "ACME" },
        organizationId: toSafeId<"organization">("org_1"),
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      templateName: "Lease",
      fileName: "lease.docx",
      completionStatus: "complete",
      text: "Lease between ACME and Tenant.",
      truncated: false,
      docxBase64: docxBytes.toString("base64"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      structureErrors: [
        {
          directive: "#if signature",
          message: "Missing closing directive",
          paragraphIndex: 4,
        },
      ],
      aiFieldErrors: [],
    });
    // The execution is recorded (fill row + audit) so agent fills are audited.
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        organizationId: toSafeId<"organization">("org_1"),
        format: "docx",
        unmatchedCount: 0,
        unusedCount: 0,
        structureErrors: [
          {
            directive: "#if signature",
            message: "Missing closing directive",
            paragraphIndex: 4,
          },
        ],
      }),
    );
  });

  test("fill_template returns rendered text and no base64 by default", async () => {
    const docxBytes = await makeDocxBuffer([
      "Lease between ACME and Tenant.",
      "Signed in Prague.",
    ]);
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: docxBytes,
      text: "Lease between ACME and Tenant.\nSigned in Prague.",
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    // The base64 archive is ~4/3 of the document's byte size; an agent that
    // only reads the result must not be charged for it.
    expect(parseToolPayload(result)).toEqual({
      templateName: "Lease",
      fileName: "lease.docx",
      completionStatus: "complete",
      paragraphs: ["Lease between ACME and Tenant.", "Signed in Prague."],
      charCount: 47,
      truncated: false,
      unmatchedPlaceholders: [],
      unusedValues: [],
      structureErrors: [],
      aiFieldErrors: [],
    });
  });

  test("fill_template keeps the prefix of a paragraph larger than the text budget", async () => {
    // A document that is one long paragraph must still render: spending the
    // budget on its prefix beats returning an empty preview. Sized well past
    // any plausible budget so the assertion does not restate the constant.
    const oversized = "x".repeat(100_000);
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: await makeDocxBuffer([oversized, "Trailing paragraph."]),
      text: oversized,
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    const payload = parseToolPayload(result);
    if (!isRecord(payload) || !Array.isArray(payload["paragraphs"])) {
      throw new TypeError("Expected a paragraph preview");
    }
    const first = payload["paragraphs"].at(0);
    if (typeof first !== "string") {
      throw new TypeError("Expected a text paragraph");
    }
    expect(payload["paragraphs"]).toHaveLength(1);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(oversized.length);
    expect(first).toBe("x".repeat(first.length));
    expect(payload["truncated"]).toBe(true);
  });

  test("fill_template rejects unmatched placeholders by default", async () => {
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: await makeDocxBuffer(["Zakres: {{scope}}"]),
      text: "Lease between ACME and {{landlord.signature}}.",
      unmatchedPlaceholders: ["landlord.signature"],
      unusedValues: [],
      aiFieldErrors: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    expect(validationEnvelope(result)).toEqual(
      expect.objectContaining({
        code: "validation_error",
        message:
          "Template fill incomplete; unmatched placeholders: landlord.signature",
      }),
    );
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({ unmatchedCount: 1 }),
    );
  });

  test("fill_template returns every missing path while bounding its summary", async () => {
    const unmatchedPlaceholders = Array.from(
      { length: 12 },
      (_, index) => `field_${index}`,
    );
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: Buffer.from("partial"),
      text: "Partial lease",
      unmatchedPlaceholders,
      unusedValues: [],
      aiFieldErrors: [],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: {} },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(validationEnvelope(result)).toEqual(
      expect.objectContaining({
        message:
          "Template fill incomplete; unmatched placeholders: field_0, field_1, field_2, field_3, field_4, field_5, field_6, field_7, field_8, field_9 (2 more omitted)",
        issues: unmatchedPlaceholders.map((placeholder) => ({
          path: `values.${placeholder}`,
          message: "Template placeholder was not filled",
        })),
        hint: expect.stringContaining("CLI: template list --template-id ID"),
      }),
    );
  });

  test("fill_template returns partial output only after an explicit completion policy", async () => {
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: await makeDocxBuffer([
        "Lease between ACME and {{landlord.signature}}.",
      ]),
      text: "Lease between ACME and {{landlord.signature}}.",
      unmatchedPlaceholders: ["landlord.signature"],
      unusedValues: [],
      aiFieldErrors: [],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        values: { "tenant.name": "ACME" },
        completion_mode: "allow_partial",
      },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).not.toBe(true);
    expect(parseToolPayload(result)).toEqual(
      expect.objectContaining({
        completionStatus: "partial",
        unmatchedPlaceholders: ["landlord.signature"],
      }),
    );
  });

  test("fill_template rejects a fill whose AI field could not be drafted", async () => {
    // The field is unfilled rather than carrying a value the model stopped
    // writing mid-word, and the tool must not report that fill as complete.
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Power of attorney",
      fileName: "poa.docx",
      buffer: Buffer.from("partial"),
      text: "Zakres: {{scope}}",
      unmatchedPlaceholders: ["scope"],
      unusedValues: [],
      aiFieldErrors: [
        {
          fieldPath: "scope",
          valuePath: "scope",
          itemIndex: null,
          reason: "truncated",
          message:
            "The model reached its output limit before finishing this field.",
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: {} },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["message"]).toContain("AI-drafted fields that failed: scope");
    expect(
      asTestRaw<{ path: string; message: string }[]>(error["issues"]),
    ).toContainEqual({
      path: "values.scope",
      message:
        "The model reached its output limit before finishing this field.",
    });
  });

  test("fill_template reports a failed AI draft under an explicit partial policy", async () => {
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      templateName: "Power of attorney",
      fileName: "poa.docx",
      buffer: await makeDocxBuffer(["Zakres: {{scope}}"]),
      text: "Zakres: {{scope}}",
      unmatchedPlaceholders: ["scope"],
      unusedValues: [],
      aiFieldErrors: [
        {
          fieldPath: "scope",
          valuePath: "scope",
          itemIndex: null,
          reason: "truncated",
          message:
            "The model reached its output limit before finishing this field.",
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        values: {},
        completion_mode: "allow_partial",
      },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).not.toBe(true);
    expect(parseToolPayload(result)).toEqual(
      expect.objectContaining({
        completionStatus: "partial",
        aiFieldErrors: [
          {
            field: "scope",
            reason: "truncated",
            message:
              "The model reached its output limit before finishing this field.",
          },
        ],
      }),
    );
  });

  test("fill_template rejects non-empty unused values by default", async () => {
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      inputRejection: {
        type: "unused-values",
        keys: ["first", "second"],
      },
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { first: "value" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    expect(validationEnvelope(result)).toEqual(
      expect.objectContaining({
        code: "validation_error",
        message: "Unused template value keys: first, second",
      }),
    );
    expect(recordTemplateFillMock).not.toHaveBeenCalled();
  });

  test("fill_template rejects a fill omitting a required, non-AI-fillable field", async () => {
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      requiredFieldsRejection: [
        {
          path: "governing_law",
          label: "Governing law",
          inputType: "select",
          options: ["Czech", "Slovak"],
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    expect(validationEnvelope(result)).toEqual(
      expect.objectContaining({
        code: "validation_error",
        message: "Missing required template values: Governing law",
        issues: [expect.objectContaining({ path: "values.governing_law" })],
      }),
    );
    // Never audited: the fill never ran (rejected before any clause/AI/lookup
    // work), so there is nothing to record.
    expect(recordTemplateFillMock).not.toHaveBeenCalled();
  });

  test("fill_template lists every missing required field in issues, not just the message preview", async () => {
    const missingFields = Array.from({ length: 12 }, (_unused, index) => ({
      path: `field_${index}`,
      label: `Field ${index}`,
      inputType: "text",
      options: null,
    }));
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      requiredFieldsRejection: missingFields,
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: {} },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    const envelope = validationEnvelope(result);
    // The summary message previews only the first ten (readability); the
    // machine-readable issues list must still carry all twelve so an agent
    // can supply every missing value in one retry.
    expect(envelope["message"]).toContain("2 more omitted");
    expect(envelope["issues"]).toHaveLength(12);
    expect(envelope["issues"]).toEqual(
      expect.arrayContaining(
        missingFields.map((field) =>
          expect.objectContaining({ path: `values.${field.path}` }),
        ),
      ),
    );
  });

  test("fill_template permits intentional unused values only with an explicit override", async () => {
    fillStoredTemplateWithTextMock.mockResolvedValue({
      templateName: "Lease",
      fileName: "lease.docx",
      buffer: await makeDocxBuffer(["Lease"]),
      text: "Lease",
      unmatchedPlaceholders: [],
      unusedValues: ["intentional"],
      aiFieldErrors: [],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        values: { intentional: "value" },
        allow_unused_values: true,
      },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).not.toBe(true);
    expect(parseToolPayload(result)).toEqual(
      expect.objectContaining({ unusedValues: ["intentional"] }),
    );
    expect(fillStoredTemplateWithTextMock).toHaveBeenCalled();
    expect(fillStoredTemplateWithTextStrictMock).not.toHaveBeenCalled();
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({ unusedCount: 1 }),
    );
  });

  test("fill_template surfaces an AI usage rejection as an error", async () => {
    // The fill service runs the usage preflight only when the template declares
    // AI fields; an over-quota org gets a rejection the MCP tool surfaces
    // instead of spending model calls.
    fillStoredTemplateWithTextStrictMock.mockResolvedValue({
      usageRejection: { message: "Monthly AI usage limit reached." },
    });

    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, values: { "tenant.name": "ACME" } },
      context: createContext(),
      toolName: "fill_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Monthly AI usage limit reached." },
    ]);
  });

  test("save_filled_template creates a document without returning base64", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "lease.docx",
      buffer: Buffer.from("filled docx"),
      unmatchedPlaceholders: [],
      unusedValues: ["unused"],
      aiFieldErrors: [],
    });
    createEntityFromBufferMock.mockImplementation(async (input) => {
      const created = {
        entityId: "entity_new",
        entityVersionId: "version_new",
        fieldId: "field_new",
        fileName: "Example Lease.docx",
      };
      await input.afterCreate(fakeTransaction, created);
      return Result.ok(created);
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "create-document-1",
        parent_id: FOLDER_ID,
        name: "Example Lease",
        values: { "tenant.name": "ACME" },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(createEntityFromBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        parentId: FOLDER_ID,
        fileName: "Example Lease.docx",
        afterCreate: expect.any(Function),
      }),
    );
    expect(fillStoredTemplateDocxMock).toHaveBeenCalledWith(
      expect.objectContaining({ useRecording: "caller" }),
    );
    expect(recordTemplateUseMock).toHaveBeenCalledWith({
      tx: fakeTransaction,
      templateId: TEMPLATE_ID,
    });
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "entity_new",
        entityVersionId: "version_new",
      }),
    );
    expect(recordTemplatePersistenceReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "create-document-1",
        requestFingerprint: "request-fingerprint",
        claimToken: "claim_1",
        result: expect.objectContaining({
          action: "create_document",
          entityId: "entity_new",
          entityVersionId: "version_new",
        }),
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      action: "create_document",
      entityId: "entity_new",
      entityVersionId: "version_new",
      fileName: "Example Lease.docx",
      unmatchedPlaceholders: [],
      unusedValues: ["unused"],
    });
    expect(JSON.stringify(parseToolPayload(result))).not.toContain("base64");
  });

  test("save_filled_template rejects a fill omitting a required, non-AI-fillable field", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      requiredFieldsRejection: [
        {
          path: "governing_law",
          label: null,
          inputType: "text",
          options: null,
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "create-document-missing-required",
        values: { "tenant.name": "ACME" },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(result.isError).toBe(true);
    expect(validationEnvelope(result)).toEqual(
      expect.objectContaining({
        code: "validation_error",
        message: "Missing required template values: governing_law",
      }),
    );
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
    expect(releaseTemplatePersistenceClaimMock).toHaveBeenCalled();
  });

  test("save_filled_template rejects failed AI fields by default and releases its claim", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "draft.docx",
      buffer: Buffer.from("optional field defaulted to blank"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [
        {
          fieldPath: "scope",
          valuePath: "scope",
          itemIndex: null,
          reason: "truncated",
          message: "Draft truncated",
        },
      ],
    });
    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "failed-ai",
        values: {},
      },
      context: createContext(),
      toolName: "save_filled_template",
    });
    expect(result.isError).toBe(true);
    expect(validationEnvelope(result)["issues"]).toEqual([
      { path: "values.scope", message: "Draft truncated" },
    ]);
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
    expect(recordTemplatePersistenceReceiptMock).not.toHaveBeenCalled();
    expect(releaseTemplatePersistenceClaimMock).toHaveBeenCalled();
  });

  test("save_filled_template persists and audits failed AI fields only under an explicit partial policy", async () => {
    const aiFieldErrors = [
      {
        fieldPath: "contracts.summary",
        valuePath: "contracts[0].summary",
        itemIndex: 1,
        reason: "generation-failed",
        message:
          "AI field generation failed. Retry or provide the value yourself.",
      },
    ];
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "draft.docx",
      buffer: Buffer.from("optional field defaulted to blank"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors,
    });
    createEntityFromBufferMock.mockImplementation(async (input) => {
      const created = {
        entityId: "entity_partial",
        entityVersionId: "version_partial",
        fieldId: "field_partial",
        fileName: "draft.docx",
      };
      await input.afterCreate(fakeTransaction, created);
      return Result.ok(created);
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "failed-ai-partial",
        values: { contracts: [{}] },
        completion_mode: "allow_partial",
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    const expectedErrors = [
      {
        field: "contracts[0].summary",
        reason: "generation-failed",
        message:
          "AI field generation failed. Retry or provide the value yourself.",
      },
    ];
    expect(parseToolPayload(result)).toEqual(
      expect.objectContaining({ aiFieldErrors: expectedErrors }),
    );
    expect(createEntityFromBufferMock).toHaveBeenCalled();
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({ unmatchedCount: 0, aiFieldErrorCount: 1 }),
    );
    expect(recordTemplatePersistenceReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ aiFieldErrors: expectedErrors }),
      }),
    );
    expect(releaseTemplatePersistenceClaimMock).not.toHaveBeenCalled();
  });

  test("save_filled_template create_version rejects failed AI fields by default before writing", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "draft.docx",
      buffer: Buffer.from("optional field defaulted to blank"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [
        {
          fieldPath: "contracts.summary",
          valuePath: "contracts[0].summary",
          itemIndex: 1,
          reason: "truncated",
          message: "Draft truncated",
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        entity_id: ENTITY_ID,
        idempotency_key: "failed-ai-version",
        values: { contracts: [{}] },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(validationEnvelope(result)["issues"]).toEqual([
      { path: "values.contracts[0].summary", message: "Draft truncated" },
    ]);
    expect(createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(recordTemplatePersistenceReceiptMock).not.toHaveBeenCalled();
    expect(releaseTemplatePersistenceClaimMock).toHaveBeenCalled();
  });

  test("save_filled_template create_version receipts exact AI errors under an explicit partial policy", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "draft.docx",
      buffer: Buffer.from("optional field defaulted to blank"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [
        {
          fieldPath: "contracts.summary",
          valuePath: "contracts[0].summary",
          itemIndex: 1,
          reason: "generation-failed",
          message:
            "AI field generation failed. Retry or provide the value yourself.",
        },
      ],
    });
    createEntityVersionFromBufferMock.mockImplementation(async (input) => {
      const created = {
        status: "ok",
        entityId: ENTITY_ID,
        entityVersionId: "version_partial",
        fieldId: "field_partial",
        fileName: "draft.docx",
        versionNumber: 3,
      };
      await input.afterWrite(fakeTransaction, created);
      return Result.ok(created);
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        entity_id: ENTITY_ID,
        idempotency_key: "failed-ai-version-partial",
        values: { contracts: [{}] },
        completion_mode: "allow_partial",
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    const expectedErrors = [
      {
        field: "contracts[0].summary",
        reason: "generation-failed",
        message:
          "AI field generation failed. Retry or provide the value yourself.",
      },
    ];
    expect(parseToolPayload(result)).toEqual(
      expect.objectContaining({
        action: "create_version",
        aiFieldErrors: expectedErrors,
      }),
    );
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({ aiFieldErrorCount: 1 }),
    );
    expect(recordTemplatePersistenceReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ aiFieldErrors: expectedErrors }),
      }),
    );
    expect(releaseTemplatePersistenceClaimMock).not.toHaveBeenCalled();
  });

  test("failed row drafts return indexed value paths and record the AI shortfall", async () => {
    for (const fieldPath of ["contracts.summary", "client.contracts.summary"]) {
      fillStoredTemplateWithTextStrictMock.mockResolvedValue({
        templateName: "Summary",
        fileName: "summary.docx",
        buffer: Buffer.from("blank optional value"),
        text: "Summary:",
        unmatchedPlaceholders: [],
        unusedValues: [],
        aiFieldErrors: [
          {
            fieldPath,
            valuePath: fieldPath.replace(".summary", "[1].summary"),
            itemIndex: 2,
            reason: "truncated",
            message: "Draft truncated",
          },
        ],
      });
      const values = fieldPath.startsWith("client.")
        ? { client: { contracts: [{}, {}] } }
        : { contracts: [{}, {}] };
      const result = await handleMcpToolCall({
        args: { template_id: TEMPLATE_ID, values },
        context: createContext(),
        toolName: "fill_template",
      });
      expect(result.isError).toBe(true);
      expect(validationEnvelope(result)["issues"]).toEqual([
        {
          path: `values.${fieldPath.replace(".summary", "[1].summary")}`,
          message: "Draft truncated",
        },
      ]);
      expect(recordTemplateFillMock).toHaveBeenCalledWith(
        expect.objectContaining({ unmatchedCount: 0, aiFieldErrorCount: 1 }),
      );
    }
  });

  test("save_filled_template does not persist after its caller disconnects", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/mcp", {
      signal: controller.signal,
    });
    fillStoredTemplateDocxMock.mockImplementation(async () => {
      controller.abort();
      return {
        fileName: "lease.docx",
        buffer: Buffer.from("filled docx"),
        unmatchedPlaceholders: [],
        unusedValues: [],
        aiFieldErrors: [],
      };
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "disconnect-1",
        values: { "tenant.name": "ACME" },
      },
      context: { ...createContext(), request },
      toolName: "save_filled_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Request cancelled before document persistence",
      },
    ]);
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
    expect(createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(recordTemplateUseMock).not.toHaveBeenCalled();
    expect(recordTemplatePersistenceReceiptMock).not.toHaveBeenCalled();
    expect(releaseTemplatePersistenceClaimMock).toHaveBeenCalled();
  });

  test("save_filled_template replays a durable idempotency receipt", async () => {
    claimTemplatePersistenceRequestMock.mockResolvedValue(
      Result.ok({
        status: "completed",
        result: {
          action: "create_document",
          entityId: "entity_existing",
          entityVersionId: "version_existing",
          fileName: "lease.docx",
          unmatchedPlaceholders: [],
          unusedValues: ["unused"],
          aiFieldErrors: [
            {
              field: "contracts[0].summary",
              reason: "generation-failed",
              message:
                "AI field generation failed. Retry or provide the value yourself.",
            },
          ],
        },
      }),
    );

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "create-document-retry",
        values: { "tenant.name": "ACME" },
      },
      context: createContext({ workspaceStatus: "archived" }),
      toolName: "save_filled_template",
    });

    expect(parseToolPayload(result)).toEqual({
      action: "create_document",
      entityId: "entity_existing",
      entityVersionId: "version_existing",
      fileName: "lease.docx",
      unmatchedPlaceholders: [],
      unusedValues: ["unused"],
      aiFieldErrors: [
        {
          field: "contracts[0].summary",
          reason: "generation-failed",
          message:
            "AI field generation failed. Retry or provide the value yourself.",
        },
      ],
    });
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
  });

  test("save_filled_template does not render behind an active claim", async () => {
    claimTemplatePersistenceRequestMock.mockResolvedValue(
      Result.ok({ status: "pending" }),
    );

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "concurrent-retry",
        values: { "tenant.name": "ACME" },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "A save with this idempotency_key is still in progress; retry shortly",
      },
    ]);
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
  });

  test("save_filled_template rejects an idempotency key reused for different input", async () => {
    claimTemplatePersistenceRequestMock.mockResolvedValue(
      Result.ok({ status: "conflict" }),
    );

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "reused-key",
        values: { "tenant.name": "Different" },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(validationEnvelope(result)).toMatchObject({
      code: "validation_error",
      message: "idempotency_key was already used for different input",
    });
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
  });

  test("save_filled_template appends a version through the shared buffer service", async () => {
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "lease",
      buffer: Buffer.from("filled docx v2"),
      unmatchedPlaceholders: ["signature"],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [
        {
          directive: "#if signature",
          message: "Missing closing directive",
          paragraphIndex: 4,
        },
      ],
    });
    createEntityVersionFromBufferMock.mockImplementation(async (input) => {
      const created = {
        status: "ok",
        entityId: ENTITY_ID,
        entityVersionId: "version_2",
        fieldId: "field_2",
        fileName: "lease.docx",
        versionNumber: 2,
      };
      await input.afterWrite(fakeTransaction, created);
      return Result.ok(created);
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "create-version-1",
        entity_id: ENTITY_ID,
        values: { "tenant.name": "ACME" },
        // The fixture leaves {{signature}} unfilled, which the default mode
        // refuses to persist; this test is about the persistence path.
        completion_mode: "allow_partial",
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(createEntityVersionFromBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        entityId: ENTITY_ID,
        fileName: "lease.docx",
        source: null,
        writePolicy: { type: "replace-current-file" },
        afterWrite: expect.any(Function),
      }),
    );
    expect(recordTemplateFillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        structureErrors: [
          {
            directive: "#if signature",
            message: "Missing closing directive",
            paragraphIndex: 4,
          },
        ],
        entityId: ENTITY_ID,
        entityVersionId: "version_2",
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      action: "create_version",
      entityId: ENTITY_ID,
      entityVersionId: "version_2",
      versionNumber: 2,
      fileName: "lease.docx",
      unmatchedPlaceholders: ["signature"],
      unusedValues: [],
    });
  });

  test("save_filled_template fingerprints every argument except the idempotency key", async () => {
    // The fingerprint decides whether a reused key replays a receipt or
    // reports a conflict, so it must cover the whole request. A field left out
    // of it lets a key answer a question it was never asked: an allow_partial
    // save replaying as success for a later require_complete retry.
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "lease",
      buffer: Buffer.from("filled docx"),
      unmatchedPlaceholders: [],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [],
    });
    createEntityVersionFromBufferMock.mockImplementation(async (input) => {
      const created = {
        status: "ok",
        entityId: ENTITY_ID,
        entityVersionId: "version_3",
        fieldId: "field_3",
        fileName: "lease.docx",
        versionNumber: 3,
      };
      await input.afterWrite(fakeTransaction, created);
      return Result.ok(created);
    });

    const args = {
      action: "create_version",
      template_id: TEMPLATE_ID,
      matter_id: WORKSPACE_ID,
      idempotency_key: "fingerprint-1",
      entity_id: ENTITY_ID,
      values: { "tenant.name": "ACME" },
      completion_mode: "allow_partial",
    } as const;
    await handleMcpToolCall({
      args,
      context: createContext(),
      toolName: "save_filled_template",
    });

    const fingerprinted = fingerprintTemplatePersistenceRequestMock.mock.calls
      .at(0)
      ?.at(0);
    if (!isRecord(fingerprinted)) {
      throw new Error("Expected fingerprinted request arguments");
    }
    // Both directions: every argument but the key is fingerprinted, and the
    // key itself never is (it is the lookup, not part of the identity).
    expect(
      Object.keys(args)
        .filter((key) => key !== "idempotency_key")
        .sort()
        .every((key) => key in fingerprinted),
    ).toBe(true);
    expect("idempotency_key" in fingerprinted).toBe(false);
    expect(fingerprinted["completion_mode"]).toBe("allow_partial");
  });

  test("save_filled_template refuses to persist a document with live placeholders", async () => {
    // The persisting tool cannot be laxer than the transient one: an unfilled
    // {{placeholder}} would otherwise reach a matter as document text.
    fillStoredTemplateDocxMock.mockResolvedValue({
      fileName: "lease",
      buffer: Buffer.from("filled docx"),
      unmatchedPlaceholders: ["signature", "landlord.name"],
      unusedValues: [],
      aiFieldErrors: [],
      structureErrors: [],
    });

    const result = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "incomplete-1",
        entity_id: ENTITY_ID,
        values: { "tenant.name": "ACME" },
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(validationEnvelope(result)).toMatchObject({
      code: "validation_error",
      message:
        "Template fill incomplete; unmatched placeholders: signature, landlord.name",
    });
    expect(createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    // The key stays reusable: nothing was written under it.
    expect(releaseTemplatePersistenceClaimMock).toHaveBeenCalled();
  });

  test("save_filled_template validates its destination before filling", async () => {
    const missingEntity = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "missing-entity-1",
        values: {},
      },
      context: createContext(),
      toolName: "save_filled_template",
    });
    const archived = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "archived-1",
        values: {},
      },
      context: createContext({ workspaceStatus: "archived" }),
      toolName: "save_filled_template",
    });
    const forbidden = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "forbidden-1",
        values: {},
      },
      context: createContext({ memberRole: "intern" }),
      toolName: "save_filled_template",
    });
    const malformedTemplate = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: "not-a-uuid",
        matter_id: WORKSPACE_ID,
        idempotency_key: "malformed-template-1",
        values: {},
      },
      context: createContext(),
      toolName: "save_filled_template",
    });
    const malformedParent = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "malformed-parent-1",
        parent_id: "not-a-uuid",
        values: {},
      },
      context: createContext(),
      toolName: "save_filled_template",
    });
    const malformedEntity = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "malformed-entity-1",
        entity_id: "not-a-uuid",
        values: {},
      },
      context: createContext(),
      toolName: "save_filled_template",
    });

    expect(missingEntity.isError).toBe(true);
    expect(validationEnvelope(missingEntity)).toMatchObject({
      code: "validation_error",
    });
    expect(archived.isError).toBe(true);
    expect(archived.content.at(0)).toMatchObject({
      type: "text",
      text: "Matter is archived; unarchive it first",
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content.at(0)).toMatchObject({
      type: "text",
      text: "Forbidden",
    });
    expect(validationEnvelope(malformedTemplate)).toMatchObject({
      code: "validation_error",
    });
    expect(validationEnvelope(malformedParent)).toMatchObject({
      code: "validation_error",
    });
    expect(validationEnvelope(malformedEntity)).toMatchObject({
      code: "validation_error",
    });
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
  });

  test("save_filled_template preflights persisted targets before fill work", async () => {
    const invalidTargets = createScopedDb([], {
      [MISSING_FOLDER_ID]: null,
      [NON_FOLDER_ID]: { kind: "document" },
      [MISSING_VERSION_ID]: null,
      [READ_ONLY_VERSION_ID]: {
        currentVersionId: "version_1",
        readOnly: true,
        currentVersion: { fields: [{ content: { type: "file" } }] },
      },
      [NON_FILE_VERSION_ID]: {
        currentVersionId: "version_1",
        readOnly: false,
        currentVersion: { fields: [{ content: { type: "text" } }] },
      },
    });
    const context = createContext({ scopedDb: invalidTargets });

    const missingParent = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "missing-parent-1",
        parent_id: MISSING_FOLDER_ID,
        values: {},
      },
      context,
      toolName: "save_filled_template",
    });
    const nonFolderParent = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "non-folder-1",
        parent_id: NON_FOLDER_ID,
        values: {},
      },
      context,
      toolName: "save_filled_template",
    });
    const missingVersionTarget = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "missing-version-1",
        entity_id: MISSING_VERSION_ID,
        values: {},
      },
      context,
      toolName: "save_filled_template",
    });
    const readOnlyVersionTarget = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "read-only-1",
        entity_id: READ_ONLY_VERSION_ID,
        values: {},
      },
      context,
      toolName: "save_filled_template",
    });
    const nonFileVersionTarget = await handleMcpToolCall({
      args: {
        action: "create_version",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "non-file-1",
        entity_id: NON_FILE_VERSION_ID,
        values: {},
      },
      context,
      toolName: "save_filled_template",
    });

    expect(missingParent.content.at(0)).toMatchObject({
      text: "Parent entity not found in this matter",
    });
    expect(nonFolderParent.content.at(0)).toMatchObject({
      text: "Parent entity must be a folder",
    });
    expect(missingVersionTarget.content.at(0)).toMatchObject({
      text: "Entity not found",
    });
    expect(readOnlyVersionTarget.content.at(0)).toMatchObject({
      text: "Entity is read-only",
    });
    expect(nonFileVersionTarget.content.at(0)).toMatchObject({
      text: "Entity has no file field",
    });
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
  });

  test("save_filled_template preflights workspace capacity before fill work", async () => {
    const fullWorkspace = createScopedDb([], {}, LIMITS.entitiesCount);

    const result = await handleMcpToolCall({
      args: {
        action: "create_document",
        template_id: TEMPLATE_ID,
        matter_id: WORKSPACE_ID,
        idempotency_key: "full-workspace-1",
        values: {},
      },
      context: createContext({ scopedDb: fullWorkspace }),
      toolName: "save_filled_template",
    });

    expect(result.content.at(0)).toMatchObject({
      text: "Entities limit reached",
    });
    expect(fillStoredTemplateDocxMock).not.toHaveBeenCalled();
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
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
      warnings: [],
    });
  });

  test("save_template (create) reports marker authoring warnings with the saved template", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_new", name: "POA", fieldCount: 2 });
    });

    const result = await handleMcpToolCall({
      args: {
        name: "POA",
        docx_base64: await makeValidDocxBase64([
          "{{#each attorneys}}",
          "{{name}}",
          "{{#endeach}}",
        ]),
      },
      context: createContext(),
      toolName: "save_template",
    });

    // The save still happens: warnings advise, they never block.
    expect(createStoredTemplateMock).toHaveBeenCalledTimes(1);
    expect(parseToolPayload(result)).toMatchObject({
      templateId: "tmpl_new",
      warnings: [
        { code: "unprefixed_item_path", path: "name" },
        { code: "unknown_directive", path: "{{#endeach}}" },
      ],
    });
  });

  test("save_template (create) reads the DOCX from a host file reference", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_hosted", name: "NDA", fieldCount: 1 });
    });
    const bytes = await makeValidDocxBytes();
    safeOutboundFetchBytesMock.mockResolvedValue(hostFileResponse(bytes));

    const result = await handleMcpToolCall({
      args: { name: "NDA", file: HOST_FILE_REFERENCE },
      context: createContext(),
      toolName: "save_template",
    });

    // Same SSRF-vetted fetch and byte ceiling the document upload uses.
    expect(safeOutboundFetchBytesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: FILE_SIZE_LIMIT_BYTES.document,
        url: HOST_FILE_REFERENCE.download_url,
      }),
    );
    // The downloaded bytes reach the same create path the base64 branch uses.
    expect(createStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "NDA",
        fileName: "NDA.docx",
        buffer: Buffer.from(bytes),
      }),
    );
    expect(parseToolPayload(result)).toEqual({
      templateId: "tmpl_hosted",
      name: "NDA",
      fieldCount: 1,
      warnings: [],
    });
  });

  test("save_template (create) rejects host-file bytes that are not a DOCX", async () => {
    safeOutboundFetchBytesMock.mockResolvedValue(
      hostFileResponse(new TextEncoder().encode("not a docx")),
    );

    const result = await handleMcpToolCall({
      args: { name: "NDA", file: HOST_FILE_REFERENCE },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "file", message: expect.any(String) },
    ]);
    // The bytes were never retyped, so the hint points at the attachment
    // rather than at base64 encoding.
    expect(error["hint"]).toContain("attached file");
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) reports a host file it cannot download", async () => {
    safeOutboundFetchBytesMock.mockResolvedValue(
      Result.err(new Error("blocked")),
    );

    const result = await handleMcpToolCall({
      args: { name: "NDA", file: HOST_FILE_REFERENCE },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["message"]).toBe("The attached file could not be downloaded");
    expect(error["issues"]).toEqual([
      { path: "file", message: "The attached file could not be downloaded" },
    ]);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
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

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "docx_base64", message: expect.any(String) },
    ]);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) blames the encoding, not the file, when the archive will not open", async () => {
    // The failure a model-driven client actually produces: the payload is
    // well-formed base64 but decodes to bytes that are no longer a readable
    // archive.
    const truncated = Buffer.from(
      await new JSZip()
        .file("word/document.xml", `<w:document xmlns:w="${W_NS}"/>`)
        .generateAsync({ type: "uint8array" }),
    ).subarray(0, 24);

    const result = await handleMcpToolCall({
      args: { name: "NDA", docx_base64: truncated.toString("base64") },
      context: createContext(),
      toolName: "save_template",
    });

    const error = validationEnvelope(result);
    const hint = error["hint"];
    expect(hint).toContain("does not decode to the original archive");
    expect(hint).toContain("do not strip parts out of it");
    // The parts the reproduced failure actually lost.
    expect(hint).toContain("styles.xml");
    // The old hint ("ensure it decodes to a valid .docx") is what invited the
    // agent to shrink the file until the call went through.
    expect(hint).not.toContain("Ensure 'docx_base64' decodes to a valid");
    // One prefix, not "Invalid DOCX file: Invalid DOCX: …".
    expect(String(error["message"]).match(/Invalid DOCX/gu)).toHaveLength(1);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) hints per failure: a readable archive missing the main part is not an encoding problem", async () => {
    const withoutDocumentXml = Buffer.from(
      await new JSZip()
        .file("word/styles.xml", "<styles/>")
        .generateAsync({ type: "uint8array" }),
    );

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: withoutDocumentXml.toString("base64"),
      },
      context: createContext(),
      toolName: "save_template",
    });

    const error = validationEnvelope(result);
    expect(error["hint"]).toContain("no 'word/document.xml'");
    expect(error["hint"]).not.toContain("does not decode");
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) hints per failure: an archive past the unpack bounds is not an encoding problem", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="${W_NS}"/>`);
    for (let index = 0; index < DOCX_MAX_ENTRIES; index += 1) {
      zip.file(`word/media/${String(index)}.bin`, "x");
    }
    // Thousands of entries outgrow the inline base64 frame, so this archive
    // arrives the way a large template does: as a host file reference.
    safeOutboundFetchBytesMock.mockResolvedValue(
      hostFileResponse(await zip.generateAsync({ type: "uint8array" })),
    );

    const result = await handleMcpToolCall({
      args: { name: "NDA", file: HOST_FILE_REFERENCE },
      context: createContext(),
      toolName: "save_template",
    });

    const error = validationEnvelope(result);
    expect(error["hint"]).toContain("entry-count or decompressed-size limit");
    // These bytes arrived intact, so retransmission advice would send the
    // caller after a fault that is not there.
    expect(error["hint"]).toContain("reattaching the same file will not help");
    expect(error["hint"]).not.toContain("does not decode");
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template (create) hints per failure: unparseable document XML is not an encoding problem", async () => {
    const malformed = Buffer.from(
      await new JSZip()
        .file(
          "word/document.xml",
          `<w:document xmlns:w="${W_NS}"><w:body><w:p></w:document>`,
        )
        .generateAsync({ type: "uint8array" }),
    );

    const result = await handleMcpToolCall({
      args: { name: "NDA", docx_base64: malformed.toString("base64") },
      context: createContext(),
      toolName: "save_template",
    });

    const error = validationEnvelope(result);
    expect(error["hint"]).toContain("is not well-formed XML");
    expect(error["hint"]).toContain("do not edit its XML by hand");
    expect(error["hint"]).not.toContain("does not decode");
    expect(String(error["message"])).toContain("Malformed document.xml");
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
            input_type: "text",
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

  test("save_template (create) reports a lookup the org cannot resolve and a format with no marker", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_new", name: "Company POA", fieldCount: 1 });
    });

    const result = await handleMcpToolCall({
      args: {
        name: "Company POA",
        // {{company}} places the default format; nothing places `address`.
        docx_base64: await makeValidDocxBase64(["{{company}}"]),
        fields: [
          {
            path: "company",
            input_type: "text",
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

    // The config is still saved: the org can enable the registry later.
    expect(createStoredTemplateMock).toHaveBeenCalledTimes(1);
    expect(parseToolPayload(result)).toMatchObject({
      warnings: [
        { code: "unmatched_lookup_format", path: "company.address" },
        { code: "registry_disabled", path: "company" },
      ],
    });
  });

  test("save_template (create) rejects a malformed field config before inserting", async () => {
    const docxBase64 = await makeValidDocxBase64();

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: docxBase64,
        // formula is mutually exclusive with ai_prompt, so isFieldMeta rejects it.
        fields: [{ path: "fee", formula: "rent * 12", ai_prompt: "draft it" }],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const error = validationEnvelope(result);
    const issues = asTestRaw<{ path: string }[]>(error["issues"]);
    expect(issues.some(({ path }) => path === "fields.0")).toBe(true);
  });

  test("save_template rejects conflicting derived source modes", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        fields: [
          {
            path: "company",
            ai_prompt: "Draft the company details",
            lookup: {
              registry: "krs",
              formats: [{ key: "default", template: "[name]" }],
            },
          },
        ],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const error = validationEnvelope(result);
    const issues = asTestRaw<{ path: string; message: string }[]>(
      error["issues"],
    );
    const conflict = issues.find(({ path }) => path === "fields.0");
    // The rejection has to name WHICH properties collided, in the snake_case
    // spelling the caller sent, and on which field: "mutually exclusive" on
    // its own leaves an agent guessing among seven properties.
    expect(conflict?.message).toContain("`ai_prompt`");
    expect(conflict?.message).toContain("`lookup`");
    expect(conflict?.message).toContain('"company"');
  });

  test("save_template reads a null-padded field entry as a plain text field", async () => {
    // GPT-family clients send `null` for every optional property they are not
    // setting. Null is absence here: without that, this entry reads as an
    // AI-drafted, conditioned, computed, looked-up, composite, bound field all
    // at once and is refused for conflicting derived sources.
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_new", name: "NDA", fieldCount: 1 });
    });

    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        fields: [
          {
            path: "name",
            label: "Client name",
            hint: null,
            input_type: null,
            options: null,
            validation: { required: true, min_length: null, pattern: null },
            required: null,
            ai_prompt: null,
            ai_adapt: null,
            ai_sees_document: null,
            parts: null,
            format: null,
            options_from: null,
            lookup: null,
            source: null,
            formula: null,
            condition: null,
            date_format: null,
          },
        ],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).not.toBe(true);
    expect(createStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientManifest: {
          fields: [
            {
              path: "name",
              label: "Client name",
              validation: { required: true },
            },
          ],
        },
      }),
    );
  });

  test("save_template still rejects a misspelled key that carries null", async () => {
    // Null is absence only for a property the surface declares: dropping it
    // for any key would turn `lable: null` into a silently accepted typo.
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        fields: [{ path: "name", lable: null }],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const issues = asTestRaw<{ path: string }[]>(
      validationEnvelope(result)["issues"],
    );
    expect(issues.some(({ path }) => path === "fields.0.lable")).toBe(true);
  });

  test("save_template rejects unknown field metadata keys before inserting", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        fields: [{ path: "fee", lable: "Misspelled label" }],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    const error = validationEnvelope(result);
    const issues = asTestRaw<{ path: string }[]>(error["issues"]);
    expect(issues.some(({ path }) => path === "fields.0.lable")).toBe(true);
  });

  test("save_template (create) surfaces the service's unknown-path rejection", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.err(
        new HandlerError({
          status: 400,
          message: "No marker {{ghost}} in the DOCX.",
          issues: [
            { path: "fields.0", message: "No marker {{ghost}} in the DOCX." },
          ],
        }),
      );
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
    // The rejection reaches the agent as the structured envelope, naming the
    // entry it sent — not as one line of bare prose it would have to parse.
    const error = validationEnvelope(result);
    expect(error["message"]).toContain("ghost");
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "fields.0", message: "No marker {{ghost}} in the DOCX." },
    ]);
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
          lookup: {
            registry: "krs",
            formats: [{ key: "default", template: "[name], KRS [krs]" }],
          },
          validation: null,
          source: null,
          aiSeesDocument: false,
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
        template_id: TEMPLATE_ID,
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
        templateId: TEMPLATE_ID,
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
          lookup: {
            registry: "krs",
            formats: [{ key: "default", template: "[name], KRS [krs]" }],
          },
        }),
      ],
    });
    expect(describeStoredTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: TEMPLATE_ID }),
    );
  });

  /**
   * A strict tool-schema client must send every declared property, so it sends
   * `null` for the ones it is not setting. Both branches of save_template have
   * to read those nulls as omissions, or a configure call collides with the
   * create rules and every derived-source property collides with the others.
   */
  test("save_template (configure) accepts a strict client's nulls for the properties it does not set", async () => {
    configureTemplateFieldsMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ manifest: { version: 1, fields: [] } });
    });
    describeStoredTemplateMock.mockResolvedValue({
      name: "Company POA",
      fields: [],
      conditions: [],
      computed: [],
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        name: null,
        docx_base64: null,
        file: null,
        fields: [
          {
            path: "company",
            label: "Company",
            hint: null,
            input_type: "text",
            options: null,
            validation: null,
            required: true,
            ai_prompt: null,
            ai_adapt: null,
            ai_sees_document: null,
            parts: null,
            format: null,
            options_from: null,
            lookup: null,
            source: null,
            formula: null,
            condition: null,
            date_format: null,
          },
        ],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBeFalsy();
    expect(configureTemplateFieldsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        fields: [
          {
            path: "company",
            label: "Company",
            inputType: "text",
            required: true,
          },
        ],
      }),
    );
  });

  test("save_template (create) accepts a strict client's nulls for template_id and the unused file property", async () => {
    createStoredTemplateMock.mockImplementation(async function* () {
      yield* [];
      return Result.ok({ id: "tmpl_new", name: "NDA", fieldCount: 3 });
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: null,
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        file: null,
        fields: null,
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBeFalsy();
    expect(parseToolPayload(result)).toEqual({
      templateId: "tmpl_new",
      name: "NDA",
      fieldCount: 3,
      warnings: [],
    });
  });

  test("save_template (configure) rejects a config whose path is unknown", async () => {
    configureTemplateFieldsMock.mockImplementation(async function* () {
      yield* [];
      return Result.err(
        new HandlerError({
          status: 400,
          message: "No marker {{ghost}} in the DOCX.",
          issues: [
            { path: "fields.0", message: "No marker {{ghost}} in the DOCX." },
          ],
        }),
      );
    });

    const result = await handleMcpToolCall({
      args: {
        template_id: TEMPLATE_ID,
        fields: [{ path: "ghost", label: "Ghost" }],
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(describeStoredTemplateMock).not.toHaveBeenCalled();
    const error = validationEnvelope(result);
    expect(error["message"]).toContain("ghost");
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "fields.0", message: "No marker {{ghost}} in the DOCX." },
    ]);
  });

  test("save_template (configure) forbids members without template:create permission", async () => {
    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, fields: [{ path: "company" }] },
      context: createContext({ memberRole: "intern" }),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Forbidden" }]);
    expect(configureTemplateFieldsMock).not.toHaveBeenCalled();
  });

  test("list_templates (detail) rejects template_id combined with a cursor", async () => {
    const result = await handleMcpToolCall({
      args: { template_id: TEMPLATE_ID, cursor: "abc" },
      context: createContext(),
      toolName: "list_templates",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "cursor applies when listing templates; omit template_id to list",
    );
    expect(error["issues"]).toEqual([
      {
        path: "cursor",
        message:
          "cursor applies when listing templates; omit template_id to list",
      },
    ]);
    expect(describeStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template rejects a request with no DOCX source and no template_id", async () => {
    const result = await handleMcpToolCall({
      args: { name: "NDA" },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Provide file or docx_base64 to create a template, or template_id to configure an existing template's fields",
    );
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
    expect(configureTemplateFieldsMock).not.toHaveBeenCalled();
  });

  test("save_template rejects a request carrying both DOCX sources", async () => {
    const result = await handleMcpToolCall({
      args: {
        name: "NDA",
        docx_base64: await makeValidDocxBase64(),
        file: HOST_FILE_REFERENCE,
      },
      context: createContext(),
      toolName: "save_template",
    });

    expect(result.isError).toBe(true);
    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Provide either file or docx_base64, not both",
    );
    expect(error["issues"]).toEqual([
      { path: "file", message: "Provide either file or docx_base64, not both" },
    ]);
    expect(safeOutboundFetchBytesMock).not.toHaveBeenCalled();
    expect(createStoredTemplateMock).not.toHaveBeenCalled();
  });

  test("save_template advertises file as a host file parameter", async () => {
    const saveTemplate = (await listMcpTools(createContext())).find(
      ({ name }) => name === "save_template",
    );

    expect(saveTemplate?._meta).toMatchObject({
      "openai/fileParams": ["file"],
    });
    expect(saveTemplate?.inputSchema).toMatchObject({
      properties: {
        file: {
          required: ["download_url", "file_id"],
          properties: {
            download_url: { type: "string" },
            file_id: { type: "string" },
            mime_type: { type: "string" },
            file_name: { type: "string" },
          },
        },
      },
    });
    // Neither source is required at the schema level; the partial checks pick
    // exactly one at parse time.
    expect(saveTemplate?.inputSchema.required).toEqual([]);
  });
});
