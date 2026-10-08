import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import JSZip from "jszip";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { filtersFromFieldConfig } from "@stll/template-conditions";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { toSafeId } from "@/api/lib/branded-types";
import type { FieldMeta } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import * as tanstackModels from "@/api/lib/tanstack-ai-models";
import * as decisionModel from "@/api/lib/workflow/decisions/decision-model";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  createTemplateAuthoringTools,
  createTemplateTools,
  DESCRIBE_TEMPLATE_TOOL_NAME,
  FILL_TEMPLATE_TOOL_NAME,
  LIST_TEMPLATES_TOOL_NAME,
  SUGGEST_TEMPLATE_FIELDS_TOOL_NAME,
} from "./template-tools.js";

type TemplateRow = { id: string; name: string; fieldCount: number };

const orgId = toSafeId<"organization">("org-test");
const userId = toSafeId<"user">("user-test");

/** Minimal scopedDb stub exposing only the templates RQB list_templates calls. */
const stubScopedDb = (
  rows: TemplateRow[],
  onFindMany?: (options: unknown) => void,
): ScopedDb => {
  const tx = {
    query: {
      templates: {
        findMany: async (options: unknown) => {
          onFindMany?.(options);
          return rows;
        },
      },
    },
  };
  // SAFETY: test double — exposes only the surface list_templates touches.
  return (async (run: (t: typeof tx) => unknown) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
    await run(tx)) as unknown as ScopedDb;
};

/** safeDb stub: the metering callbacks only touch it on a model step, which
 *  these tool-registration tests never trigger (no orgAIConfig), so it is
 *  never invoked. */
// SAFETY: test double — never called because no AI generation runs here.
const stubSafeDb = (() => {
  throw new Error("safeDb stub must not be called");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
}) as unknown as SafeDb;

describe("createTemplateTools", () => {
  test("registers list, describe and fill template tools", () => {
    const tools = createTemplateTools({
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      scopedDb: stubScopedDb([]),
      safeDb: stubSafeDb,
      organizationId: orgId,
      modelAdmission: testModelAdmission(orgId),
      userId,
      thirdPartyBoundary: { type: "raw" },
    });
    expect(tools[LIST_TEMPLATES_TOOL_NAME]).toBeDefined();
    expect(tools[DESCRIBE_TEMPLATE_TOOL_NAME]).toBeDefined();
    expect(tools[FILL_TEMPLATE_TOOL_NAME]).toBeDefined();
  });

  // The use-gated factory must not leak the authoring tool: a fill-only role
  // (intern: template `use` without `create`) registers these tools, so
  // `suggest_template_fields` belongs to `createTemplateAuthoringTools` instead.
  test("does not register the authoring-only suggest tool", () => {
    const tools = createTemplateTools({
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      scopedDb: stubScopedDb([]),
      safeDb: stubSafeDb,
      organizationId: orgId,
      modelAdmission: testModelAdmission(orgId),
      userId,
      thirdPartyBoundary: { type: "raw" },
    });
    expect(SUGGEST_TEMPLATE_FIELDS_TOOL_NAME in tools).toBe(false);
  });

  test("list_templates explicitly scopes the organization query", async () => {
    const rows: TemplateRow[] = [
      { id: "t1", name: "NDA", fieldCount: 4 },
      { id: "t2", name: "Power of Attorney", fieldCount: 7 },
    ];
    let findManyOptions: unknown;
    const tools = createTemplateTools({
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      scopedDb: stubScopedDb(rows, (options) => {
        findManyOptions = options;
      }),
      safeDb: stubSafeDb,
      organizationId: orgId,
      modelAdmission: testModelAdmission(orgId),
      userId,
      thirdPartyBoundary: { type: "raw" },
    });
    // SAFETY: invoke the tool's execute directly with a stub call context.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const execute = tools[LIST_TEMPLATES_TOOL_NAME].execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<{ templates: TemplateRow[] }>;

    const result = await execute({}, {});
    expect(result).toEqual({ templates: rows });
    expect(findManyOptions).toMatchObject({
      where: { organizationId: { eq: orgId } },
    });
  });
});

describe("fill_template grades the fill", () => {
  const s3Key = "fake-key-chat-fill";
  const conditionField: FieldMeta = {
    path: "is_consumer",
    label: "Consumer contract",
    inputType: "boolean",
    aiPrompt: "Is this a consumer contract?",
  };

  const gatedDocx = async (): Promise<Uint8Array> => {
    const body = [
      "Preamble.",
      "{% if is_consumer %}",
      "Consumer notice.",
      "{% endif %}",
    ]
      .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
      .join("");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    const { file } = await writeFieldFilters(
      testDocxFile(await zip.generateAsync({ type: "uint8array" })),
      [],
      [
        {
          path: conditionField.path,
          expression: undefined,
          filters: filtersFromFieldConfig(conditionField),
        },
      ],
    );
    return new Uint8Array(file.bytes);
  };

  /** Run fill_template over `docx` behind `thirdPartyBoundary` with no AI
   *  backend of any tier, returning the tool result and the fill rows. */
  const runFill = async ({
    docx,
    values,
    thirdPartyBoundary,
  }: {
    docx: Uint8Array;
    values: Record<string, unknown>;
    thirdPartyBoundary: ChatThirdPartyBoundary;
  }) => {
    const providerSpy = spyOn(
      tanstackModels,
      "hasTanStackInstanceProvider",
    ).mockReturnValue(false);
    const decisionSpy = spyOn(
      decisionModel,
      "hasInstanceDecisionModel",
    ).mockReturnValue(false);
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, docx);
      const rows: Record<string, unknown>[] = [];
      const { scopedDb } = createScopedDbMock({
        query: {
          templates: {
            findFirst: async () => ({
              name: "NDA",
              fileName: "nda.docx",
              s3Key,
              scanState: "scanned",
              languages: [],
            }),
          },
          businessRegistryCredentials: { findMany: async () => [] },
          templateClauses: { findMany: async () => [] },
        },
        insert: () => ({
          values: async (row: Record<string, unknown>) => {
            rows.push(row);
            await Promise.resolve();
          },
        }),
        update: () => ({
          set: () => ({
            where: async () => {
              await Promise.resolve();
            },
          }),
        }),
      });
      const tools = createTemplateTools({
        orgAIConfig: null,
        managedAIResidency: "eu" as const,
        scopedDb,
        safeDb: stubSafeDb,
        organizationId: orgId,
        modelAdmission: testModelAdmission(orgId),
        userId,
        thirdPartyBoundary,
      });
      const execute = asTestRaw<
        (input: unknown, options: unknown) => Promise<Record<string, unknown>>
      >(tools[FILL_TEMPLATE_TOOL_NAME].execute);

      const result = await execute(
        { templateId: "00000000-0000-4000-8000-000000000001", values },
        {},
      );
      return { result, rows };
    } finally {
      fakeS3.stop();
      providerSpy.mockRestore();
      decisionSpy.mockRestore();
    }
  };

  test("an undecided AI condition records and returns the fill as partial", async () => {
    const { result, rows } = await runFill({
      docx: await gatedDocx(),
      values: {},
      thirdPartyBoundary: { type: "raw" },
    });

    expect(result).toMatchObject({
      completionStatus: "partial",
      shortfall: [
        {
          path: "values.is_consumer",
          message:
            'AI-decided condition "Consumer contract" was left undecided (no-backend); supply true or false for it.',
        },
      ],
      conditionDecisions: [
        {
          path: "is_consumer",
          label: "Consumer contract",
          state: "undecided",
          reason: "no-backend",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({ status: "partial", format: "text" });
  });

  test("a value still holding an anonymization placeholder records and returns the fill as partial", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Signed by {{party_name}}.</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    const thirdPartyBoundary = createChatThirdPartyBoundary({
      anonymizeFields: async ({ fields }: { fields: string[] }) =>
        Result.ok({ entityCount: 0, fields, redactionMap: new Map() }),
      anonymizationScopeId: "workspace-A",
      organizationId: orgId,
      scopedDb: createScopedDbMock({}).scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });

    // A placeholder the turn never sent cannot be restored, so the document
    // carries the placeholder instead of a name.
    const { result, rows } = await runFill({
      docx: await zip.generateAsync({ type: "uint8array" }),
      values: { party_name: "[PERSON_4]" },
      thirdPartyBoundary,
    });

    expect(result).toMatchObject({
      text: "Signed by [PERSON_4].",
      completionStatus: "partial",
      shortfall: [
        {
          path: "values.party_name",
          message:
            "The value still holds an anonymization placeholder, so the document carries the placeholder instead of the real value; supply the real value.",
        },
      ],
      unrestoredFields: ["party_name"],
    });
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({ status: "partial", format: "text" });
  });
});

describe("createTemplateAuthoringTools", () => {
  test("registers the suggest-fields authoring tool", () => {
    const tools = createTemplateAuthoringTools({
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      safeDb: stubSafeDb,
      organizationId: orgId,
      modelAdmission: testModelAdmission(orgId),
      userId,
      thirdPartyBoundary: { type: "raw" },
    });
    expect(tools[SUGGEST_TEMPLATE_FIELDS_TOOL_NAME]).toBeDefined();
  });

  test("prepares the nested request for the send mode and restores its suggestions", async () => {
    const anonymizeFields = async ({ fields }: { fields: string[] }) => {
      const redactionMap = new Map<string, string>();
      const anonymized = fields.map((field) => {
        if (!field.includes("Dana Novotná")) {
          return field;
        }
        redactionMap.set("[PERSON_1]", "Dana Novotná");
        return field.replaceAll("Dana Novotná", "[PERSON_1]");
      });
      return Result.ok({
        entityCount: redactionMap.size,
        fields: anonymized,
        redactionMap,
      });
    };
    const thirdPartyBoundary = createChatThirdPartyBoundary({
      anonymizeFields,
      anonymizationScopeId: "workspace-A",
      organizationId: orgId,
      scopedDb: createScopedDbMock({}).scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });
    const sentTexts: string[] = [];
    const tools = createTemplateAuthoringTools({
      orgAIConfig: null,
      managedAIResidency: "eu" as const,
      safeDb: stubSafeDb,
      organizationId: orgId,
      modelAdmission: testModelAdmission(orgId),
      userId,
      thirdPartyBoundary,
      dependencies: {
        suggestTemplateFields: async ({ documentText }) => {
          sentTexts.push(documentText);
          return [
            { fieldPath: "party.name", literalText: "[PERSON_1]" },
            // A placeholder the turn never sent matches nothing in the
            // document.
            { fieldPath: "witness.name", literalText: "[PERSON_4]" },
          ];
        },
      },
    });
    const execute: unknown = tools[SUGGEST_TEMPLATE_FIELDS_TOOL_NAME].execute;
    if (typeof execute !== "function") {
      throw new TypeError("Expected a server tool");
    }

    const result: unknown = await Reflect.apply(execute, undefined, [
      { instructions: null, text: "Signed by Dana Novotná." },
      {},
    ]);

    expect(sentTexts).toEqual(["Signed by [PERSON_1]."]);
    expect(result).toEqual({
      suggestions: [{ fieldPath: "party.name", literalText: "Dana Novotná" }],
      unrestoredFields: ["witness.name"],
    });
  });
});
