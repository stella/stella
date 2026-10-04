import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import fc from "fast-check";
import JSZip from "jszip";

import { assertProperty } from "@stll/property-testing";
import { filtersFromFieldConfig } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import type { discoverHandler } from "@/api/handlers/templates/discover";
import discoverEndpoint from "@/api/handlers/templates/discover";
import { toSafeId } from "@/api/lib/branded-types";
import { clauseBodyToRichPatch } from "@/api/lib/clauses/clause-to-patch";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { AI_FIELD_ADAPTATION_FAILURE_MESSAGE } from "@/api/lib/docx/adapt-ai-fields";
import { CONDITION_RAW_VALUES } from "@/api/lib/docx/block-directives";
import { fillTemplate } from "@/api/lib/docx/patch-template";
import type { AiConditionDecider } from "@/api/lib/docx/resolve-ai-conditions";
import { partParagraphTexts } from "@/api/lib/docx/rich-patch";
import type { TemplateData, FieldMeta } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  decideTemplateFillCompletion,
  fillDiagnosticsOf,
  templateFillStatus,
} from "./template-fill-completion";
import {
  describeStoredTemplate,
  fillStoredTemplateDocx,
  fillTemplateDocx,
  fillTemplateDocxStrict,
  discoverTemplateSource,
  clauseDirectiveRecoveryHint,
} from "./template-fill-service";

// ── DOCX fixture helpers (mirrors patch-template.test.ts / templates.test.ts:
// no shared fixture module exists yet, so every suite builds its own) ──────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<ScannedFile> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  return testDocxFile(await zip.generateAsync({ type: "uint8array" }));
};

const extractTexts = async (file: ScannedFile): Promise<string[]> => {
  const zip = await JSZip.loadAsync(file.bytes);
  const documentXmlFile =
    zip.file("word/document.xml") ??
    panic("fixture DOCX is missing word/document.xml");
  const xml = await documentXmlFile.async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/gu)].map(
    (match) => match[1] ?? "",
  );
};

const organizationId = toSafeId<"organization">("org_1");

const stubScopedDb = (
  clauseBody?: ClauseBody,
  storedS3Key?: string,
): ScopedDb => {
  const fakeTx = {
    query: {
      businessRegistryCredentials: { findMany: async () => [] },
      templates: {
        findFirst: async () => ({
          name: "Terms",
          fileName: "terms.docx",
          s3Key: storedS3Key,
          scanState: "scanned",
          languages: [],
          manifest: { version: 1, fields: [] },
          templateClauses: [
            { id: "link_1", clause: { body: clauseBody, versions: [] } },
          ],
        }),
      },
      templateClauses: {
        findMany: async () =>
          clauseBody === undefined
            ? []
            : [
                {
                  clause: { id: toSafeId<"clause">("cls_1"), title: "Terms" },
                  slotName: "Terms",
                  clauseId: toSafeId<"clause">("cls_1"),
                  clauseVariantId: null,
                  clauseVariantLabel: null,
                  clauseVersionId: toSafeId<"clauseVersion">("clsv_1"),
                },
              ],
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: toSafeId<"clauseVersion">("clsv_1"),
              clauseId: toSafeId<"clause">("cls_1"),
              version: 1,
              body: clauseBody,
            },
          ],
        }),
      }),
    }),
  };
  // SAFETY: the fill service reads registry credentials and, for a stored
  // source, the pinned clause links and version rows modeled above.
  return (async (fn: (tx: unknown) => Promise<unknown>) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
    fn(fakeTx)) as unknown as ScopedDb;
};

/**
 * The document with each field's configuration authored into the marker that
 * declares it: the DOCX is the only place a template's fields are configured,
 * so a fixture that names a path the document does not carry is a fixture the
 * code under test never sees.
 */
const authorFieldMarkers = async (
  docx: ScannedFile,
  fields: readonly FieldMeta[],
): Promise<ScannedFile> => {
  const { file, written } = await writeFieldFilters(
    docx,
    fields.map((field) => ({
      path: field.path,
      filters: filtersFromFieldConfig(field),
    })),
  );
  for (const { path } of fields) {
    if (!written.has(path)) {
      throw new Error(`fixture has no {{${path}}} marker to configure`);
    }
  }
  return file;
};

/**
 * A condition the document only gates a block with has no value marker to
 * carry its configuration, so its rule, label and AI instruction live in the
 * `{% if %}` tag itself. Mirrors what `configure_template_fields` writes.
 */
const authorConditionTags = async (
  docx: ScannedFile,
  fields: readonly FieldMeta[],
): Promise<ScannedFile> => {
  const { file, written } = await writeFieldFilters(
    docx,
    [],
    fields.map((field) => ({
      path: field.path,
      expression: field.condition,
      filters:
        field.condition === undefined ? filtersFromFieldConfig(field) : [],
    })),
  );
  for (const { path } of fields) {
    if (!written.has(path)) {
      throw new Error(`fixture has no {% if ${path} %} tag to configure`);
    }
  }
  return file;
};

const requiredTextField: FieldMeta = {
  path: "governing_law",
  label: "Governing law",
  inputType: "text",
  required: true,
};

const makeConfiguredDocx = async (fields: FieldMeta[]): Promise<ScannedFile> =>
  authorFieldMarkers(
    await makeDocx(WRAP(P("Governed by {{governing_law}} law."))),
    fields,
  );

describe("fillTemplateDocx required-field rejection", () => {
  test("rejects a fill omitting a required, non-AI-fillable field", async () => {
    const file = await makeConfiguredDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect(result).toEqual({
      requiredFieldsRejection: [
        {
          path: "governing_law",
          label: "Governing law",
          inputType: "text",
          options: null,
        },
      ],
    });
  });

  test("rejects when the required field is present but empty", async () => {
    const file = await makeConfiguredDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: { governing_law: "" },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when the required field is whitespace-only", async () => {
    const file = await makeConfiguredDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: { governing_law: "   " },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when a required loop item field is missing in one array row", async () => {
    const file = await makeDocx(
      WRAP(
        [
          P("{% for person in persons %}"),
          P("{{ person.member }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    const withManifest = await authorFieldMarkers(file, [
      { path: "persons.member", label: "Member", required: true },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", file: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "" }] },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect(result).toEqual({
      requiredFieldsRejection: [
        {
          path: "persons.member",
          label: "Member",
          inputType: "text",
          options: null,
        },
      ],
    });
  });

  test("fills when every array row supplies the required loop item field", async () => {
    const file = await makeDocx(
      WRAP(
        [
          P("{% for person in persons %}"),
          P("{{ person.member }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    const withManifest = await authorFieldMarkers(file, [
      { path: "persons.member", label: "Member", required: true },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", file: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "Bob" }] },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.file);
    expect(texts.join("")).toContain("Alice");
    expect(texts.join("")).toContain("Bob");
  });

  test("fills when the required field is provided", async () => {
    const file = await makeConfiguredDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: { governing_law: "Czech" },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.file);
    expect(texts.join("")).toContain("Governed by Czech law.");
  });

  test("does not reject a required field that is AI-fillable when omitted; drafts it instead", async () => {
    const file = await makeConfiguredDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        aiPrompt: "The governing law most likely intended by the parties.",
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: async () => ({
        generateAiValue: async () => ({ type: "drafted", value: "Slovak" }),
      }),
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.file);
    expect(texts.join("")).toContain("Governed by Slovak law.");
    expect(result.aiFieldErrors).toEqual([]);
  });

  test("reports a field the model could not draft and leaves it unfilled", async () => {
    const file = await makeConfiguredDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        aiPrompt: "The governing law most likely intended by the parties.",
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: async () => ({
        generateAiValue: async () => ({
          type: "failed",
          reason: "truncated",
          message: "The model reached its output limit before finishing.",
        }),
      }),
    });

    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    // The cut draft is reported instead of being written into the instrument.
    expect(result.aiFieldErrors).toEqual([
      {
        fieldPath: "governing_law",
        valuePath: "governing_law",
        itemIndex: null,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ]);
    expect(result.unmatchedPlaceholders).toContain("governing_law");
  });

  test("reports a field the model could not adapt, fills its stub and grades the fill partial", async () => {
    const file = await makeConfiguredDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        aiAdapt: true,
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: { governing_law: "czech" },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: async () => ({ adaptAiValue: async () => undefined }),
    });

    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    // The stub still fills the marker, but nobody asked for that wording.
    expect((await extractTexts(result.file)).join("")).toContain(
      "Governed by czech law.",
    );
    expect(result.unmatchedPlaceholders).toEqual([]);
    expect(result.aiFieldErrors).toEqual([
      {
        fieldPath: "governing_law",
        valuePath: "governing_law",
        itemIndex: null,
        reason: "generation-failed",
        message: AI_FIELD_ADAPTATION_FAILURE_MESSAGE,
      },
    ]);
    expect(templateFillStatus(fillDiagnosticsOf(result))).toBe("partial");
  });

  test("does not reject a required, source-bound field left unfilled", async () => {
    const file = await makeConfiguredDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        source: { kind: "matter", field: "reference" },
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    // No matter is bound (no workspaceId), so the source field simply stays
    // unfilled rather than being flagged as a caller-correctable omission.
    expect("requiredFieldsRejection" in result).toBe(false);
  });

  // The collaborator factory costs an org AI config read and a metered trace,
  // so the service must not resolve it for a manifest that declares no AI
  // field. A factory that throws proves it was never called.
  test("never resolves the AI collaborators for a deterministic manifest", async () => {
    const file = await makeConfiguredDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file },
      values: { governing_law: "Czech" },
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: () =>
        panic("deterministic fill resolved the AI collaborators"),
    });

    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.file);
    expect(texts.join("")).toContain("Governed by Czech law.");
  });

  test("does not check required fields on a manifest-less template", async () => {
    const file = await makeDocx(WRAP(P("Hello {{name}}.")));

    const result = await fillTemplateDocx({
      source: { name: "Plain", fileName: "plain.docx", file },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
  });
});

// The service owns the use counter, but a persistence caller that writes its
// own atomic transaction (fill-by-id, save_filled_template) takes it over with
// `useRecording: "caller"`. `fillStoredTemplateDocx` dropped that option while
// forwarding, so those callers bumped the counter twice per fill; these run
// through that wrapper, the one that was broken.

describe("fillStoredTemplateDocx use recording", () => {
  const usedTemplateId = toSafeId<"template">("tmpl_use");
  const storedS3Key = "fake-key-use-recording";
  const storedRow = {
    name: "NDA",
    fileName: "nda.docx",
    s3Key: storedS3Key,
    scanState: "scanned",
    languages: [],
  };

  /** ScopedDb stub serving the stored template row and counting the
   *  `templates` use-counter update. `findFirst` honours the organization
   *  predicate the loader sends, so a mismatch reads as "not found" exactly as
   *  the query would in Postgres. */
  const storedTemplateScopedDb = (): {
    scopedDb: ScopedDb;
    updates: () => number;
  } => {
    let updates = 0;
    const fakeTx = {
      query: {
        businessRegistryCredentials: { findMany: async () => [] },
        templates: {
          findFirst: async ({
            where,
          }: {
            where: {
              id: { eq: string };
              organizationId?: { eq: string } | undefined;
            };
          }) =>
            // An absent predicate returns the row: that is what the query
            // looked like before, so the cross-organization case below fails
            // if the predicate is ever dropped again.
            where.id.eq === usedTemplateId &&
            (where.organizationId === undefined ||
              where.organizationId.eq === organizationId)
              ? storedRow
              : undefined,
        },
      },
      update: () => {
        updates += 1;
        return { set: () => ({ where: async () => undefined }) };
      },
    };
    // SAFETY: test stub; this fill touches the template row, registry
    // credential configuration, and the use-counter update counted above.
    const scopedDb = (async (fn: (tx: unknown) => Promise<unknown>) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
      fn(fakeTx)) as unknown as ScopedDb;
    return { scopedDb, updates: () => updates };
  };

  const fillStored = async (
    options: Pick<
      Parameters<typeof fillStoredTemplateDocx>[0],
      "organizationId" | "useRecording"
    >,
  ) => {
    const file = await makeConfiguredDocx([requiredTextField]);
    const { scopedDb, updates } = storedTemplateScopedDb();
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", storedS3Key, new Uint8Array(file.bytes));
      const result = await fillStoredTemplateDocx({
        templateId: usedTemplateId,
        values: { governing_law: "Czech" },
        scopedDb,
        thirdPartyOutboundPermit: undefined,
        requiredFields: "enforce",
        ...options,
      });
      return { result, updates: updates() };
    } finally {
      fakeS3.stop();
    }
  };

  test("bumps the use counter once by default", async () => {
    const { result, updates } = await fillStored({ organizationId });

    expect("file" in result).toBe(true);
    expect(updates).toBe(1);
  });

  test("leaves the counter to the caller under useRecording: caller", async () => {
    const { result, updates } = await fillStored({
      organizationId,
      useRecording: "caller",
    });

    expect("file" in result).toBe(true);
    expect(updates).toBe(0);
  });

  // Tenant isolation on a cross-tenant-addressable id must not rest on RLS
  // alone: the loader's own predicate has to reject a template that belongs to
  // another organization even when the session role does not.
  test("does not load a template belonging to another organization", async () => {
    const { result, updates } = await fillStored({
      organizationId: toSafeId<"organization">("org_other"),
    });

    expect(result).toMatchObject({ error: "Template not found." });
    if (!("storedTemplateError" in result)) {
      panic("Expected a structured stored-template error");
    }
    expect(result.storedTemplateError).toBeInstanceOf(HandlerError);
    expect(result.storedTemplateError.status).toBe(404);
    expect(updates).toBe(0);
  });
});

describe("fillTemplateDocx condition decisions", () => {
  /** A document whose only paragraph is gated by an AI-decided condition, so
   *  the rendered text alone cannot say whether the condition was false or
   *  never settled. */
  const gatedDocx = async (): Promise<ScannedFile> =>
    await authorConditionTags(
      await authorFieldMarkers(
        await makeDocx(
          WRAP(
            [
              P("{% if is_consumer %}"),
              P("Consumer notice. {{governing_law}}"),
              P("{% endif %}"),
            ].join(""),
          ),
        ),
        [{ path: "governing_law", label: "Governing law", inputType: "text" }],
      ),
      [
        {
          path: "is_consumer",
          label: "Consumer contract",
          inputType: "boolean",
          aiPrompt: "Is this a consumer contract?",
        },
      ],
    );

  const fillGated = async ({
    decide,
    values = { governing_law: "Czech" },
  }: {
    decide: AiConditionDecider;
    values?: Record<string, unknown>;
  }) => {
    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file: await gatedDocx() },
      values,
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: async () => ({ decideAiCondition: decide }),
    });
    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    return result;
  };

  test("reports the decision model's answer with the probability it chose", async () => {
    const result = await fillGated({
      decide: async () => ({
        decidedBy: "decision_model",
        value: true,
        probability: 0.94,
      }),
    });

    expect(result.conditionDecisions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: true,
        decidedBy: "decision_model",
        probability: 0.94,
      },
    ]);
    expect((await extractTexts(result.file)).join("")).toContain(
      "Consumer notice.",
    );
  });

  test("reports the generative fallback's answer, which carries no probability", async () => {
    const result = await fillGated({
      decide: async () => ({ decidedBy: "generative_model", value: false }),
    });

    expect(result.conditionDecisions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: false,
        decidedBy: "generative_model",
      },
    ]);
    // The gated paragraph is out, which is why the decision has to be reported.
    expect((await extractTexts(result.file)).join("")).not.toContain(
      "Consumer notice.",
    );
  });

  test("a value the caller supplied wins and is reported as theirs", async () => {
    let asked = false;
    const result = await fillGated({
      values: { governing_law: "Czech", is_consumer: true },
      decide: async () => {
        asked = true;
        return { decidedBy: "generative_model", value: false };
      },
    });

    expect(asked).toBe(false);
    expect(result.conditionDecisions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: true,
        decidedBy: "user",
      },
    ]);
  });

  test("a condition no tier could settle is reported undecided, not false", async () => {
    const result = await fillGated({ decide: async () => undefined });

    expect(result.conditionDecisions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "undecided",
        reason: "failed",
      },
    ]);
    expect((await extractTexts(result.file)).join("")).not.toContain(
      "Consumer notice.",
    );
  });
});

describe("fillTemplateDocx undecided AI conditions grade the fill", () => {
  const conditionField: FieldMeta = {
    path: "is_consumer",
    label: "Consumer contract",
    inputType: "boolean",
    aiPrompt: "Is this a consumer contract?",
  };

  /** One block gated on the condition and one on its negation, around an
   *  ungated paragraph: whichever way an unset condition renders, one block
   *  goes and one stays without anyone deciding either. */
  const negatedDocx = async (): Promise<ScannedFile> =>
    await authorConditionTags(
      await makeDocx(
        WRAP(
          [
            P("Preamble."),
            P("{% if is_consumer %}"),
            P("Consumer notice."),
            P("{% endif %}"),
            P("{% if not is_consumer %}"),
            P("Business terms."),
            P("{% endif %}"),
          ].join(""),
        ),
      ),
      [conditionField],
    );

  const fill = async (decideAiCondition: AiConditionDecider | undefined) => {
    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", file: await negatedDocx() },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      aiCollaborators: async () =>
        decideAiCondition === undefined ? {} : { decideAiCondition },
    });
    if (!("file" in result)) {
      throw new Error("expected a filled document");
    }
    return result;
  };

  const cases = [
    { reason: "failed", decide: async () => undefined },
    { reason: "no-backend", decide: undefined },
  ] as const;

  for (const { reason, decide } of cases) {
    test(`a ${reason} condition makes the fill partial and is named with its reason`, async () => {
      const result = await fill(decide);
      const diagnostics = fillDiagnosticsOf(result);

      expect(diagnostics.undecidedConditions).toEqual([
        {
          path: "is_consumer",
          label: "Consumer contract",
          state: "undecided",
          reason,
        },
      ]);
      // Nothing else fell short: the undecided condition alone is why.
      expect(result.unmatchedPlaceholders).toEqual([]);
      expect(result.aiFieldErrors).toEqual([]);
      expect(templateFillStatus(diagnostics)).toBe("partial");
      const decision = decideTemplateFillCompletion({
        mode: "require_complete",
        diagnostics,
      });
      expect(decision.type).toBe("rejected_partial");
      if (decision.type === "complete") {
        throw new Error("expected a shortfall");
      }
      expect(decision.blockingKinds).toEqual(["undecidedConditions"]);

      // The renderer still never picks a side for it: the unset condition
      // reads as false, which the diagnostics above make visible.
      const text = (await extractTexts(result.file)).join("");
      expect(text).toContain("Preamble.");
      expect(text).not.toContain("Consumer notice.");
      expect(text).toContain("Business terms.");
    });
  }

  test("a condition the model decides keeps the fill complete", async () => {
    const result = await fill(async () => ({
      decidedBy: "generative_model",
      value: true,
    }));
    const diagnostics = fillDiagnosticsOf(result);
    expect(diagnostics.undecidedConditions).toEqual([]);
    expect(templateFillStatus(diagnostics)).toBe("success");
    const text = (await extractTexts(result.file)).join("");
    expect(text).toContain("Consumer notice.");
    expect(text).not.toContain("Business terms.");
  });
});

describe("describeStoredTemplate gated blocks", () => {
  const templateId = toSafeId<"template">("tmpl_2");
  const s3Key = "fake-key-conditions";

  const stubDescribeScopedDb = (): ScopedDb => {
    const fakeTx = {
      query: {
        templates: {
          findFirst: async () => ({
            name: "Engagement letter",
            fileName: "engagement.docx",
            s3Key,
            scanState: "scanned",
          }),
        },
      },
    };
    // SAFETY: test stub; describeStoredTemplate only reads the templates row
    // through this scopedDb (the DOCX comes from the fake S3 below).
    return (async (fn: (tx: unknown) => Promise<unknown>) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
      fn(fakeTx)) as unknown as ScopedDb;
  };

  test("lists every {% if %} block by its governing path and kind", async () => {
    // A rule's filters ride on the value marker that carries the field; an
    // AI-decided condition the document never prints has only its `{% if %}`
    // tag to be configured in. Both shapes appear here, plus a plain boolean
    // the person answers.
    const file = await authorConditionTags(
      await authorFieldMarkers(
        await makeDocx(
          WRAP(
            [
              P("{% if is_consumer %}"),
              P("Consumer notice."),
              P("{% endif %}"),
              P("{% if is_corp %}"),
              P("Corporate notice: {{is_corp}}"),
              P("{% endif %}"),
              P("{% if signed %}"),
              P("Signed on {{signed_on}}."),
              P("{% endif %}"),
            ].join(""),
          ),
        ),
        [
          { path: "signed_on", label: "Signed on", inputType: "date" },
          {
            path: "is_corp",
            inputType: "boolean",
            condition: "party_type == 'corp'",
          },
        ],
      ),
      [
        {
          path: "is_consumer",
          inputType: "boolean",
          aiPrompt: "Is this a consumer contract?",
        },
      ],
    );

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(file.bytes));
      const result = await describeStoredTemplate({
        templateId,
        organizationId,
        scopedDb: stubDescribeScopedDb(),
      });
      if ("error" in result) {
        throw new Error(result.error);
      }

      // `signed` is a plain boolean the person answers: before this it was
      // absent from `conditions` entirely, so nothing said it gated a block.
      expect(result.conditions).toEqual([
        {
          path: "is_consumer",
          kind: "ai",
          prompt: "Is this a consumer contract?",
        },
        { path: "is_corp", kind: "rule", condition: "party_type == 'corp'" },
        { path: "signed", kind: "asked" },
      ]);
    } finally {
      fakeS3.stop();
    }
  });
});

describe("describeStoredTemplate array shape", () => {
  const templateId = toSafeId<"template">("tmpl_1");

  const s3Key = "fake-key-unused-because-loadTemplate-is-bypassed";

  const stubDescribeScopedDb = (): ScopedDb => {
    const fakeTx = {
      query: {
        templates: {
          findFirst: async () => ({
            name: "Engagement letter",
            fileName: "engagement.docx",
            s3Key,
            scanState: "scanned",
          }),
        },
      },
    };
    // SAFETY: test stub; describeStoredTemplate only reads the templates row
    // through this scopedDb (S3 is exercised separately below via fake-s3).
    return (async (fn: (tx: unknown) => Promise<unknown>) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double; see SAFETY above
      fn(fakeTx)) as unknown as ScopedDb;
  };

  test("groups an {% for %} loop over object items under `arrays`, distinct from `fields`", async () => {
    let file = await makeDocx(
      WRAP(
        [
          P("{% for deliverable in deliverables %}"),
          P("{{ deliverable.name }} due {{ deliverable.due_date }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    file = await authorFieldMarkers(file, [
      { path: "deliverables.name", label: "Name", inputType: "text" },
      { path: "deliverables.due_date", label: "Due date", inputType: "date" },
    ]);

    // describeStoredTemplate loads via S3; exercise it against the fake store.
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(file.bytes));
      const result = await describeStoredTemplate({
        templateId,
        organizationId,
        scopedDb: stubDescribeScopedDb(),
      });

      if ("error" in result) {
        throw new Error(`unexpected error: ${result.error}`);
      }
      expect(result.arrays).toHaveLength(1);
      const group = result.arrays.at(0);
      expect(group?.path).toBe("deliverables");
      expect(group?.itemFieldPaths.toSorted()).toEqual(["due_date", "name"]);
      // The array root is a field of its own (its item counts configure it),
      // and the item fields still appear individually beside it.
      expect(result.fields.map((field) => field.path).toSorted()).toEqual([
        "deliverables",
        "deliverables.due_date",
        "deliverables.name",
      ]);
    } finally {
      fakeS3.stop();
    }
  });

  test("includes an object-item loop whose sole item field happens to be named `value`", async () => {
    // {{entries.value}} is genuinely ambiguous from marker text alone: it is
    // both the primitive-loop convention (values.entries an array of
    // scalars) and what an object-item loop over `{ value }` rows discovers
    // (values.entries an array of objects). Suppressing this group entirely
    // would hide the latter, real case from a caller; it must stay listed.
    let file = await makeDocx(
      WRAP(
        [
          P("{% for entry in entries %}"),
          P("{{ entry.value }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    file = await authorFieldMarkers(file, [
      { path: "entries.value", label: "Value", inputType: "text" },
    ]);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(file.bytes));
      const result = await describeStoredTemplate({
        templateId,
        organizationId,
        scopedDb: stubDescribeScopedDb(),
      });

      if ("error" in result) {
        throw new Error(`unexpected error: ${result.error}`);
      }
      expect(result.arrays).toEqual([
        { path: "entries", itemFieldPaths: ["value"] },
      ]);
    } finally {
      fakeS3.stop();
    }
  });
});

describe("linked clause directive filling", () => {
  test.each([true, false])(
    "selects exactly the linked clause branch for x=%s",
    async (x) => {
      const body: ClauseBody = [
        {
          text: "{% if x %}",
          isDirective: true,
          directiveKind: "if",
          directiveExpression: "x",
        },
        { text: "Included" },
        { text: "{% else %}", isDirective: true, directiveKind: "else" },
        { text: "Alternative" },
        { text: "{% endif %}", isDirective: true, directiveKind: "endif" },
      ];
      const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
      const result = await fillTemplateDocx({
        source: {
          name: "Terms",
          fileName: "terms.docx",
          file,
          templateId: toSafeId<"template">("tmpl_1"),
        },
        values: { x },
        scopedDb: stubScopedDb(body),
        organizationId,
        thirdPartyOutboundPermit: undefined,
        requiredFields: "enforce",
        useRecording: "caller",
      });
      if (!("file" in result)) {
        panic(`linked clause fill rejected: ${JSON.stringify(result)}`);
      }
      expect(await extractTexts(result.file)).toEqual([
        x ? "Included" : "Alternative",
      ]);
      expect(result.structureErrors).toEqual([]);
    },
  );
});

const clauseDirective = (text: string) => ({ text, isDirective: true });

const fillLinkedClause = async (
  body: ClauseBody,
  values: TemplateData,
  options: { templateBody?: string; override?: ClauseBody } = {},
) => {
  const file = await makeDocx(
    WRAP(options.templateBody ?? P('{{ clause("Terms") }}')),
  );
  return fillTemplateDocx({
    source: {
      name: "Terms",
      fileName: "terms.docx",
      file,
      templateId: toSafeId<"template">("tmpl_1"),
    },
    scopedDb: stubScopedDb(body),
    organizationId,
    thirdPartyOutboundPermit: undefined,
    requiredFields: "enforce",
    values,
    useRecording: "caller",
    ...(options.override === undefined
      ? {}
      : { clauseOverrides: { "@clause:Terms": options.override } }),
  });
};

const filledTexts = async (
  result: Awaited<ReturnType<typeof fillLinkedClause>>,
) => {
  if (!("file" in result)) {
    panic(`clause fill rejected: ${JSON.stringify(result)}`);
  }
  const zip = await JSZip.loadAsync(result.file.bytes);
  const xml =
    (await zip.file("word/document.xml")?.async("string")) ??
    panic("filled document has no body");
  return partParagraphTexts(xml);
};

describe("clause and template directive parity", () => {
  const branches = [
    clauseDirective("{% if x %}"),
    { text: "Yes" },
    clauseDirective("{% else %}"),
    { text: "No" },
    clauseDirective("{% endif %}"),
  ];
  test.each([
    {},
    { x: "" },
    { x: false },
    { x: true },
    { x: 0 },
    { x: 1 },
    { x: "false" },
    { x: "true" },
    { x: "value" },
    { x: [] },
    { x: ["value"] },
    { x: {} },
    { x: { value: "present" } },
  ] satisfies TemplateData[])(
    "resolves identical template and clause conditions for %j",
    async (values) => {
      const result = await fillLinkedClause(branches, values, {
        templateBody:
          branches.map(({ text }) => P(text)).join("") +
          P('{{ clause("Terms") }}'),
      });
      const texts = await filledTexts(result);
      expect(texts).toHaveLength(2);
      expect(texts.at(0)).toBe(texts.at(1));
      expect(texts.join("")).not.toContain("{%");
    },
  );

  test.each([
    { values: { x: true, y: false }, expected: ["Outer", "Inner no"] },
    { values: { x: true, y: true }, expected: ["Outer", "Inner yes"] },
    { values: { x: false, y: true }, expected: ["Elif"] },
    { values: { x: false, y: false }, expected: ["Else"] },
  ])(
    "resolves nested branches and elif chains for %j",
    async ({ values, expected }) => {
      const body = [
        clauseDirective("{% if x %}"),
        { text: "Outer" },
        clauseDirective("{% if y %}"),
        { text: "Inner yes" },
        clauseDirective("{% else %}"),
        { text: "Inner no" },
        clauseDirective("{% endif %}"),
        clauseDirective("{% elif y %}"),
        { text: "Elif" },
        clauseDirective("{% else %}"),
        { text: "Else" },
        clauseDirective("{% endif %}"),
      ];
      expect(await filledTexts(await fillLinkedClause(body, values))).toEqual([
        ...expected,
      ]);
      expect(
        await filledTexts(
          await fillLinkedClause([{ text: "Stored" }], values, {
            override: body,
          }),
        ),
      ).toEqual([...expected]);
    },
  );

  test("expands nested loops with per-item conditions, counters, formatting and list labels", async () => {
    const body: ClauseBody = [
      clauseDirective("{% for party in parties %}"),
      clauseDirective("{% if party.include %}"),
      {
        text: "{{ party.name }}",
        runs: [{ text: "{{ party.name }}", bold: true }],
        listKind: "ordered",
      },
      clauseDirective("{% for term in party.terms %}"),
      {
        text: "{{ loop.index }}: {{ term.value }}",
        runs: [{ text: "{{ loop.index }}: {{ term.value }}", italic: true }],
        listKind: "ordered",
        listLevel: 1,
      },
      clauseDirective("{% endfor %}"),
      clauseDirective("{% endif %}"),
      clauseDirective("{% endfor %}"),
    ];
    const result = await fillLinkedClause(body, {
      parties: [
        { name: "Alpha", include: true, terms: ["A", "B"] },
        { name: "Excluded", include: false, terms: ["Hidden"] },
        { name: "Beta", include: true, terms: ["C"] },
      ],
    });
    expect(await filledTexts(result)).toEqual([
      "1. Alpha",
      "    a. 1: A",
      "    b. 2: B",
      "2. Beta",
      "    a. 1: C",
    ]);
    if (!("file" in result)) {
      panic("expected filled clause");
    }
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toContain("<w:b");
    expect(xml).toContain("<w:i");
    expect(xml).not.toContain("__each_");
  });

  test("keeps an empty loop empty and clause-local expansion keys isolated", async () => {
    const body = [
      clauseDirective("{% for row in rows %}"),
      { text: "{{ row.value }}" },
      clauseDirective("{% endfor %}"),
    ];
    expect(
      await filledTexts(await fillLinkedClause(body, { rows: [] })),
    ).toEqual([]);
    expect(
      await filledTexts(
        await fillLinkedClause(
          body,
          { rows: ["one", "two"] },
          {
            templateBody:
              P("{% for row in rows %}") +
              P("Template {{ row.value }}") +
              P("{% endfor %}") +
              P('{{ clause("Terms") }}'),
          },
        ),
      ),
    ).toEqual(["Template one", "Template two", "one", "two"]);
  });

  test("preserves XML output for a clause without markers", async () => {
    const body: ClauseBody = [
      { text: "First", runs: [{ text: "First", bold: true }] },
      { text: "Second", listKind: "ordered" },
    ];
    const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
    const direct = await fillTemplate(file, {
      "@clause:Terms": {
        paragraphs: [
          { runs: [{ text: "First", bold: true }] },
          { runs: [{ text: "1. Second" }] },
        ],
      },
    });
    const result = await fillTemplateDocx({
      source: {
        name: "Terms",
        fileName: "terms.docx",
        file,
        templateId: toSafeId<"template">("tmpl_1"),
      },
      values: {},
      scopedDb: stubScopedDb(body),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      useRecording: "caller",
    });
    if (!("file" in result)) {
      panic("expected filled clause");
    }
    const actualZip = await JSZip.loadAsync(result.file.bytes);
    const expectedZip = await JSZip.loadAsync(direct.file.bytes);
    expect(Object.keys(actualZip.files).toSorted()).toEqual(
      Object.keys(expectedZip.files).toSorted(),
    );
    for (const path of Object.keys(expectedZip.files).filter((partName) =>
      partName.endsWith(".xml"),
    )) {
      expect(await actualZip.file(path)?.async("string")).toBe(
        await expectedZip.file(path)?.async("string"),
      );
    }
  });

  test.each([
    { body: [clauseDirective("{% if x %}"), { text: "Unclosed" }] },
    { body: [clauseDirective("{% else %}"), { text: "Orphan" }] },
    { body: [clauseDirective("{% endif %}")] },
    {
      body: [
        clauseDirective("{% for row in rows %}"),
        { text: "Unclosed loop" },
      ],
    },
    { body: [clauseDirective("{% if x %}"), clauseDirective("{% endfor %}")] },
    { body: [clauseDirective("invalid")] },
  ])(
    "retains malformed stored clauses literally and refuses malformed per-fill overrides: %j",
    async ({ body }) => {
      const stored = await fillLinkedClause([...body], {});
      expect(await filledTexts(stored)).toEqual(body.map(({ text }) => text));
      if (!("file" in stored)) {
        panic("expected legacy fill");
      }
      expect(stored.clauseWarnings).toMatchObject([
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: "Terms",
          version: 1,
          slotKey: "@clause:Terms",
        },
      ]);
      const result = await fillLinkedClause(
        [{ text: "Stored" }],
        {},
        { override: [...body] },
      );
      expect(result).not.toHaveProperty("file");
      if (!("error" in result)) {
        panic("expected clause rejection");
      }
      expect(result.storedTemplateError).toBeInstanceOf(HandlerError);
      expect(result.storedTemplateError?.status).toBe(422);
      expect(result.storedTemplateError?.code).toBe(
        "clause_directives_invalid",
      );
      expect(result.storedTemplateError?.retryable).toBe(false);
      expect(result.storedTemplateError?.hint).toContain("override");
    },
  );
});

type DirectiveTree =
  | { kind: "text"; text: string }
  | {
      kind: "condition";
      yes: DirectiveTree[];
      elif: DirectiveTree[];
      no: DirectiveTree[];
    }
  | {
      kind: "loop";
      path: "rows1" | "rows2" | "rows3";
      children: DirectiveTree[];
    };

const directiveTreeArbitrary = (depth: number): fc.Arbitrary<DirectiveTree> => {
  const leaf = fc
    .constantFrom("Alpha", "Beta", "Gamma")
    .map((text) => ({ kind: "text", text }) as const);
  if (depth === 0) {
    return leaf;
  }
  const children = fc.array(directiveTreeArbitrary(depth - 1), {
    minLength: 1,
    maxLength: 2,
  });
  const paths = ["rows1", "rows2", "rows3"] as const;
  const path = paths.at(depth - 1) ?? panic("Unexpected generated loop depth");
  return fc.oneof(
    leaf,
    fc.record({
      kind: fc.constant("condition"),
      yes: children,
      elif: children,
      no: children,
    }),
    fc.record({
      kind: fc.constant("loop"),
      path: fc.constant(path),
      children,
    }),
  );
};

const treeClauseBody = (nodes: DirectiveTree[]): ClauseBody =>
  nodes.flatMap((node) => {
    switch (node.kind) {
      case "text":
        return [{ text: node.text }];
      case "condition":
        return [
          clauseDirective("{% if x %}"),
          ...treeClauseBody(node.yes),
          clauseDirective("{% elif y %}"),
          ...treeClauseBody(node.elif),
          clauseDirective("{% else %}"),
          ...treeClauseBody(node.no),
          clauseDirective("{% endif %}"),
        ];
      case "loop":
        return [
          clauseDirective(`{% for item in ${node.path} %}`),
          { text: "{{ item.name }} #{{ loop.index }}" },
          ...treeClauseBody(node.children),
          clauseDirective("{% endfor %}"),
        ];
      default:
        node satisfies never;
        throw new TypeError("Unhandled generated directive tree");
    }
  });

test("filled clause directive trees match template body rendering", async () => {
  await assertProperty(
    "filled clause directive trees match template body rendering",
    fc.asyncProperty(
      fc.array(directiveTreeArbitrary(3), { minLength: 1, maxLength: 3 }),
      fc.record({
        x: fc.boolean(),
        y: fc.boolean(),
        rows1: fc.array(
          fc.record({
            name: fc.constantFrom("A", "B"),
            x: fc.boolean(),
            y: fc.boolean(),
          }),
          { maxLength: 3 },
        ),
        rows2: fc.array(
          fc.record({
            name: fc.constantFrom("C", "D"),
            x: fc.boolean(),
            y: fc.boolean(),
          }),
          { maxLength: 3 },
        ),
        rows3: fc.array(
          fc.record({
            name: fc.constantFrom("E", "F"),
            x: fc.boolean(),
            y: fc.boolean(),
          }),
          { maxLength: 3 },
        ),
      }),
      async (tree, values) => {
        const result = await fillLinkedClause(treeClauseBody(tree), values);
        const texts = await filledTexts(result);
        const templateFile = await makeDocx(
          WRAP(
            treeClauseBody(tree)
              .map(({ text }) => P(text))
              .join(""),
          ),
        );
        const bodyResult = await fillTemplate(templateFile, values);
        expect(bodyResult.structureErrors).toEqual([]);
        const bodyZip = await JSZip.loadAsync(bodyResult.file.bytes);
        const bodyXml =
          (await bodyZip.file("word/document.xml")?.async("string")) ??
          panic("missing body XML");
        expect(texts).toEqual(partParagraphTexts(bodyXml));
        expect(texts.join("")).not.toContain("{%");
      },
    ),
  );
});

test("strict fills discover condition and loop inputs in linked and adjusted clauses", async () => {
  const body = [
    clauseDirective("{% if x %}"),
    clauseDirective("{% for row in rows %}"),
    { text: "{{ row.value }}" },
    clauseDirective("{% endfor %}"),
    clauseDirective("{% endif %}"),
  ];
  const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
  for (const override of [undefined, body]) {
    const result = await fillTemplateDocxStrict({
      source: {
        name: "Terms",
        fileName: "terms.docx",
        file,
        templateId: toSafeId<"template">("tmpl_1"),
      },
      values: { x: true, rows: ["Alpha", "Beta"] },
      scopedDb: stubScopedDb(
        override === undefined ? body : [{ text: "Stored" }],
      ),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      useRecording: "caller",
      ...(override === undefined
        ? {}
        : { clauseOverrides: { "@clause:Terms": override } }),
    });
    if (!("file" in result)) {
      panic(`strict clause fill rejected: ${JSON.stringify(result)}`);
    }
    expect(await extractTexts(result.file)).toEqual(["Alpha", "Beta"]);
  }
});

test("clause resolution uses formula outputs and rule-backed named conditions", async () => {
  const body = [
    clauseDirective("{% if eligible %}"),
    { text: "Eligible" },
    clauseDirective("{% else %}"),
    { text: "Other" },
    clauseDirective("{% endif %}"),
  ];
  const file = await authorFieldMarkers(
    await makeDocx(
      WRAP(
        P("{{total}}") +
          P("{% if eligible %}") +
          P("Template eligible") +
          P("{% endif %}") +
          P('{{ clause("Terms") }}'),
      ),
    ),
    [{ path: "total", inputType: "number", formula: "base * 2" }],
  );
  const result = await fillTemplateDocx({
    source: {
      name: "Terms",
      fileName: "terms.docx",
      file,
      templateId: toSafeId<"template">("tmpl_1"),
    },
    values: { base: 10 },
    scopedDb: stubScopedDb(body),
    organizationId,
    thirdPartyOutboundPermit: undefined,
    requiredFields: "enforce",
    useRecording: "caller",
  });
  // The condition comes from the clause's own authored declaration.
  const namedBody = [
    clauseDirective('{% if eligible | checkbox | condition("total > 15") %}'),
    ...body.slice(1),
  ];
  const namedResult = await fillTemplateDocx({
    source: {
      name: "Terms",
      fileName: "terms.docx",
      file,
      templateId: toSafeId<"template">("tmpl_1"),
    },
    values: { base: 10 },
    scopedDb: stubScopedDb(namedBody),
    organizationId,
    thirdPartyOutboundPermit: undefined,
    requiredFields: "enforce",
    useRecording: "caller",
  });
  expect(await filledTexts(result)).toEqual(["20", "Other"]);
  expect(await filledTexts(namedResult)).toEqual([
    "20",
    "Template eligible",
    "Eligible",
  ]);
});

test("clauses compare raw dates while rendering formatted dates including loop rows", () => {
  const body = [
    clauseDirective('{% if date > "2028-01-01" %}'),
    { text: "After" },
    clauseDirective("{% endif %}"),
    clauseDirective("{% for row in rows %}"),
    clauseDirective('{% if row.date > "2028-01-01" %}'),
    { text: "{{ row.date }}" },
    clauseDirective("{% endif %}"),
    clauseDirective("{% endfor %}"),
  ];
  const values = {
    date: "13. června 2028",
    rows: [{ date: "14. června 2028" }, { date: "1. ledna 2020" }],
    [CONDITION_RAW_VALUES]: {
      date: "2028-06-13",
      "rows.0.date": "2028-06-14",
      "rows.1.date": "2020-01-01",
    },
  };
  const patch = clauseBodyToRichPatch(body, {
    values,
    slotKey: "@clause:Terms",
  }).unwrap();
  if (typeof patch === "string") {
    panic("expected rich clause patch");
  }
  expect(
    patch.paragraphs.map(({ runs }) => runs.map(({ text }) => text).join("")),
  ).toEqual(["After", "14. června 2028"]);
});

test("template discovery and condition preview include clause-only declarations", async () => {
  const body = [
    clauseDirective(
      '{% if included | checkbox | ai("Include this provision?") %}',
    ),
    { text: "Included" },
    clauseDirective("{% else %}"),
    { text: "Excluded" },
    clauseDirective("{% endif %}"),
  ];
  const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
  const source = {
    name: "Terms",
    fileName: "terms.docx",
    file,
    templateId: toSafeId<"template">("tmpl_1"),
  };
  const { manifest, discovered } = await discoverTemplateSource({
    source,
    scopedDb: stubScopedDb(body),
    organizationId,
  });
  expect(discovered.conditionPaths).toContain("included");
  expect(manifest.fields).toContainEqual(
    expect.objectContaining({
      path: "included",
      aiPrompt: "Include this provision?",
    }),
  );
  const overrideDiscovery = await discoverTemplateSource({
    source,
    scopedDb: stubScopedDb(body),
    organizationId,
    clauseOverrides: {
      "@clause:Terms": [
        clauseDirective(
          '{% if replacement | checkbox | ai("Include the replacement?") %}',
        ),
        { text: "Replacement" },
        clauseDirective("{% endif %}"),
      ],
    },
  });
  expect(overrideDiscovery.discovered.conditionPaths).toEqual(["replacement"]);
  const { templateDecideConditionsLogic } =
    await import("./template-decide-conditions");
  const previewDb = createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          manifest: {
            version: 1,
            fields: [],
            clauseSlots: [{ name: "Terms", patchKey: "@clause:Terms" }],
          },
        }),
      },
      templateClauses: {
        findMany: async () => [
          {
            slotName: "Terms",
            clauseId: toSafeId<"clause">("cls_preview"),
            clauseVersionId: toSafeId<"clauseVersion">("clsv_preview"),
            clauseVariantId: null,
            clauseVariantLabel: null,
            clause: { id: toSafeId<"clause">("cls_preview"), title: "Terms" },
          },
        ],
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: toSafeId<"clauseVersion">("clsv_preview"),
              clauseId: toSafeId<"clause">("cls_preview"),
              version: 1,
              body,
            },
          ],
        }),
      }),
    }),
  });
  const preview = await templateDecideConditionsLogic({
    scopedDb: previewDb.scopedDb,
    organizationId,
    templateId: source.templateId,
    body: { values: { included: false } },
    orgAIConfig: null,
    client: null,
    abortSignal: new AbortController().signal,
  });
  expect(preview.unwrap().conditions).toEqual([
    {
      path: "included",
      label: "included",
      decision: { state: "decided", decidedBy: "user", value: false },
    },
  ]);
  expect(
    await filledTexts(await fillLinkedClause(body, { included: false })),
  ).toEqual(["Excluded"]);
});

test("placeholder-only clauses use finalized fill values", async () => {
  expect(
    await filledTexts(
      await fillLinkedClause([{ text: "Buyer: {{ buyer }}" }], {
        buyer: "ACME",
      }),
    ),
  ).toEqual(["Buyer: ACME"]);
});

test("empty clause results remove only the numbered slot paragraph", async () => {
  const numbered = (text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const result = await fillLinkedClause(
    [
      clauseDirective("{% if included %}"),
      { text: "Optional" },
      clauseDirective("{% endif %}"),
    ],
    { included: false },
    {
      templateBody:
        numbered("Before") +
        numbered('{{ clause("Terms") }}') +
        numbered("After"),
    },
  );
  expect(await filledTexts(result)).toEqual(["Before", "After"]);
  if (!("file" in result)) {
    panic("expected a filled file");
  }
  const zip = await JSZip.loadAsync(result.file.bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  expect(xml?.match(/<w:numPr>/gu)).toHaveLength(2);
});

test("clause date declarations format body occurrences and preserve raw condition values through fill", async () => {
  const result = await fillLinkedClause(
    [
      clauseDirective('{% if signed_on > "2028-01-01" %}'),
      { text: '{{ signed_on | date("cs-long") }}' },
      clauseDirective("{% else %}"),
      { text: "Earlier" },
      clauseDirective("{% endif %}"),
    ],
    { signed_on: "2028-06-13" },
    { templateBody: P("{{ signed_on }}") + P('{{ clause("Terms") }}') },
  );
  expect(await filledTexts(result)).toEqual([
    "13. června 2028",
    "13. června 2028",
  ]);
});

test.each([false, true])(
  "inline clause conditions agree with body for %j",
  async (included) => {
    const text = "Prefix {% if included %}Yes{% else %}No{% endif %} suffix";
    const result = await fillLinkedClause(
      [{ text }],
      { included },
      { templateBody: P(text) + P('{{ clause("Terms") }}') },
    );
    expect(await filledTexts(result)).toEqual([
      included ? "Prefix Yes suffix" : "Prefix No suffix",
      included ? "Prefix Yes suffix" : "Prefix No suffix",
    ]);
  },
);

test("stored web discovery, description and effective fill declarations agree for clause-only inputs", async () => {
  const clauseBody = [
    { text: '{{ party | label("Clause party") | required }}' },
  ];
  const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
  const templateId = toSafeId<"template">(
    "00000000-0000-4000-8000-000000000001",
  );
  const fakeS3 = startFakeS3();
  try {
    fakeS3.put("stella", "clause-web-discovery", new Uint8Array(file.bytes));
    const scopedDb = stubScopedDb(clauseBody, "clause-web-discovery");
    const app = new Elysia().post(
      "/templates/discover",
      async ({ body, request }) =>
        await discoverEndpoint.handler(
          createTestHandlerContext<
            Parameters<typeof discoverEndpoint.handler>[0]
          >({
            scopedDb,
            session: { activeOrganizationId: organizationId },
            body,
            request,
            route: "/templates/discover",
          }),
        ),
      { body: discoverEndpoint.config.body },
    );
    const form = new FormData();
    form.set(
      "file",
      new File([file.bytes], "terms.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    form.set("templateId", templateId);
    const response = await app.handle(
      new Request("http://localhost/templates/discover", {
        method: "POST",
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    const web =
      await readTestJson<
        Extract<
          Awaited<ReturnType<typeof discoverHandler>>,
          { status: "ok" }
        >["value"]
      >(response);
    const description = await describeStoredTemplate({
      templateId,
      scopedDb,
      organizationId,
    });
    const effective = await discoverTemplateSource({
      source: { name: "Terms", fileName: "terms.docx", file, templateId },
      scopedDb,
      organizationId,
    });
    expect(web.fields).toContainEqual(
      expect.objectContaining({
        path: "party",
        label: "Clause party",
        required: true,
      }),
    );
    if (!("fields" in description)) {
      panic("Expected template description");
    }
    expect(web.fields.map(({ path }) => path)).toEqual(
      description.fields.map(({ path }) => path),
    );
    expect(web.fields.map(({ path }) => path)).toEqual(
      effective.manifest.fields.map(({ path }) => path),
    );
    const filled = await fillStoredTemplateDocx({
      templateId,
      values: { party: "Acme" },
      scopedDb,
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "enforce",
      useRecording: "caller",
    });
    if (!("file" in filled)) {
      panic("Expected deterministic fill");
    }
    expect(filled.unusedValues).toEqual([]);
    expect(await extractTexts(filled.file)).toEqual(["Acme"]);
  } finally {
    fakeS3.stop();
  }
});

test("clause filter errors identify their slot and clause-relative paragraph", async () => {
  const clauseBody = [{ text: "{{ party | date() }}" }];
  const file = await makeDocx(
    WRAP(P("Template paragraph") + P('{{ clause("Terms") }}')),
  );
  const result = await discoverTemplateSource({
    source: {
      name: "Terms",
      fileName: "terms.docx",
      file,
      templateId: toSafeId<"template">("tmpl_1"),
    },
    scopedDb: stubScopedDb(clauseBody),
    organizationId,
  });
  expect(result.discovered.structureErrors.length).toBeGreaterThanOrEqual(1);
  for (const error of result.discovered.structureErrors) {
    expect(error.source).toBe("clause");
    expect(error.clause).toMatchObject({
      slotKey: "@clause:Terms",
      id: "cls_1",
      name: "Terms",
    });
    expect([0, 1]).toContain(error.paragraphIndex);
  }
});

test("clause AI declarations run usage admission and include linked content in grounding", async () => {
  const body = [
    clauseDirective("{% if active %}"),
    { text: "Payment is due within thirty days." },
    clauseDirective("{% else %}"),
    { text: "Inactive payment requires immediate settlement." },
    clauseDirective("{% endif %}"),
    { text: '{{ summary | ai("Summarize", sees_document=true) }}' },
  ];
  const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
  let admissions = 0;
  const result = await fillTemplateDocx({
    source: {
      name: "Terms",
      fileName: "terms.docx",
      file,
      templateId: toSafeId<"template">("tmpl_1"),
    },
    values: { active: true },
    organizationId,
    thirdPartyOutboundPermit: undefined,
    scopedDb: stubScopedDb(body),
    requiredFields: "enforce",
    useRecording: "caller",
    assertUsageAvailable: async () => {
      admissions++;
      return null;
    },
    aiCollaborators: async () => ({
      generateAiValue: async ({ documentText, values }) => {
        expect(documentText).toContain("Payment is due within thirty days.");
        expect(documentText).not.toContain("Inactive payment");
        expect(documentText).not.toContain("{% if");
        expect(documentText).not.toContain("{{ summary");
        expect(values["@clause:Terms"]).toContain(
          "Payment is due within thirty days.",
        );
        return { type: "drafted", value: "Thirty days" };
      },
    }),
  });
  expect(admissions).toBe(1);
  if ("usageRejection" in result) {
    throw new TypeError("Expected admitted fill");
  }
  expect(await filledTexts(result)).toEqual([
    "Payment is due within thirty days.",
    "Thirty days",
  ]);
});

test.each(["latest", "pinned", "explicit"] as const)(
  "legacy recovery describes the resolved %s version",
  (resolution) => {
    const hint = clauseDirectiveRecoveryHint({
      slotKey: "Terms",
      name: "Terms",
      resolution,
      version: 2,
    });
    expect(hint).toContain("list_clauses");
    expect(hint).toContain("save_clause");
    expect(hint).toContain("snapshot_version=true");
    expect(hint).not.toContain("get_clause");
    if (resolution === "pinned") {
      expect(hint).toContain("Sync the pinned template clause link");
    }
    if (resolution === "explicit") {
      expect(hint).toContain(":vN");
    }
    if (resolution === "latest") {
      expect(hint).toContain("working copy alone does not publish");
    }
  },
);

describe("clause fill boundaries", () => {
  test("authored override validation precedes usage and collaborator work", async () => {
    const file = await authorFieldMarkers(
      await makeDocx(WRAP(P('{{ clause("Terms") }}') + P("{{ drafted }}"))),
      [{ path: "drafted", aiPrompt: "Draft the provision" }],
    );
    let usageCalls = 0;
    let collaboratorCalls = 0;
    const result = await fillTemplateDocx({
      source: {
        name: "Terms",
        fileName: "terms.docx",
        file,
        templateId: toSafeId<"template">("tmpl_1"),
      },
      values: {},
      scopedDb: stubScopedDb([{ text: "Stored" }]),
      organizationId,
      thirdPartyOutboundPermit: undefined,
      requiredFields: "allow-partial",
      useRecording: "caller",
      clauseOverrides: {
        "@clause:Terms": [clauseDirective("{% if enabled %}")],
      },
      assertUsageAvailable: async () => {
        usageCalls++;
        return null;
      },
      aiCollaborators: async () => {
        collaboratorCalls++;
        return {};
      },
    });
    expect(result).toMatchObject({
      storedTemplateError: { status: 422, code: "clause_directives_invalid" },
    });
    expect(usageCalls).toBe(0);
    expect(collaboratorCalls).toBe(0);
  });

  test.each(["enforce", "allow-partial"] as const)(
    "reports remaining clause fields with %s required fields",
    async (requiredFields) => {
      const file = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
      const result = await fillTemplateDocx({
        source: {
          name: "Terms",
          fileName: "terms.docx",
          file,
          templateId: toSafeId<"template">("tmpl_1"),
        },
        values: {},
        scopedDb: stubScopedDb([{ text: "Buyer: {{ buyer }}" }]),
        organizationId,
        thirdPartyOutboundPermit: undefined,
        requiredFields,
        useRecording: "caller",
      });
      if (!("file" in result)) {
        panic("expected filled document");
      }
      expect((await extractTexts(result.file)).join("")).toContain(
        "{{ buyer }}",
      );
      expect(result.unmatchedPlaceholders).toEqual(["buyer"]);
    },
  );
});
