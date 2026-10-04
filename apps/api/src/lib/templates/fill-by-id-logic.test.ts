import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { filtersFromFieldConfig } from "@stll/template-conditions";

import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { fillByIdLogic } from "./fill-by-id-logic";

/**
 * The document with each field's configuration authored into the marker that
 * declares it: the DOCX is the only place a template's fields are configured,
 * so a fixture naming a path the document does not carry configures nothing.
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

// fillByIdLogic backs `POST /templates/:templateId/fill`. Like fillHandler
// (the raw-upload route), it used to run applyManifestFillSteps/fillTemplate
// directly with no required-field check; it must apply the same shared gate
// (collectMissingRequiredFields, policy "enforce") every other real fill does.

// ── DOCX fixture helpers (mirrors templates.test.ts / patch-template.test.ts:
// no shared fixture module exists yet) ──────────────────────────────────────

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

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const templateId = toSafeId<"template">("tmpl_1");
const s3Key = "fake-key-fill-by-id-test";

const recordAuditEvent: AuditRecorder = async () => {
  await Promise.resolve();
};

const requiredFieldManifest: TemplateManifest = {
  version: 1,
  fields: [{ path: "governing_law", label: "Governing law", required: true }],
};

const stubDb = (fileName: string) =>
  createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          name: "Template",
          fileName,
          s3Key,
          scanState: "scanned",
          languages: [],
        }),
      },
      businessRegistryCredentials: { findMany: async () => [] },
      templateClauses: { findMany: async () => [] },
    },
  });

describe("fillByIdLogic required fields", () => {
  test("rejects a fill omitting a required field, with the full structured detail", async () => {
    let docx = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    docx = await authorFieldMarkers(docx, requiredFieldManifest.fields);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
      const { safeDb, scopedDb } = stubDb("nda.docx");

      const result = await Result.gen(() =>
        fillByIdLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values: {} },
          query: {},
          recordAuditEvent,
        }),
      );

      expect(Result.isError(result)).toBe(true);
      if (!Result.isError(result)) {
        throw new TypeError("Expected the fill to be rejected");
      }
      expect(HandlerError.is(result.error)).toBe(true);
      if (!HandlerError.is(result.error)) {
        throw new TypeError("Expected a HandlerError rejection");
      }
      expect(result.error.status).toBe(400);
      expect(result.error.message).toContain("Governing law");
      // The message alone loses each field's input type/options; the
      // structured detail must carry the full rejection so a client can
      // render the right control per field and retry with all of them.
      expect(result.error.requiredFields).toEqual([
        {
          path: "governing_law",
          label: "Governing law",
          inputType: "text",
          options: null,
        },
      ]);
    } finally {
      fakeS3.stop();
    }
  });

  test("rejects a fill whose required value is whitespace-only", async () => {
    let docx = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    docx = await authorFieldMarkers(docx, requiredFieldManifest.fields);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
      const { safeDb, scopedDb } = stubDb("nda.docx");

      const result = await Result.gen(() =>
        fillByIdLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values: { governing_law: "   " } },
          query: {},
          recordAuditEvent,
        }),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(HandlerError.is(result.error) && result.error.status).toBe(400);
      }
    } finally {
      fakeS3.stop();
    }
  });

  test("rejects when a required loop item field is missing in one row", async () => {
    let docx = await makeDocx(
      WRAP(
        [
          P("{% for person in persons %}"),
          P("{{ person.member }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    docx = await authorFieldMarkers(docx, [
      { path: "persons.member", label: "Member", required: true },
    ]);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
      const { safeDb, scopedDb } = stubDb("roster.docx");

      const result = await Result.gen(() =>
        fillByIdLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: {
            values: { persons: [{ member: "Alice" }, { member: "" }] },
          },
          query: {},
          recordAuditEvent,
        }),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(HandlerError.is(result.error) && result.error.status).toBe(400);
        expect(result.error.message).toContain("Member");
      }
    } finally {
      fakeS3.stop();
    }
  });

  test("rejects when a required loop item field's row is not an object", async () => {
    let docx = await makeDocx(
      WRAP(
        [
          P("{% for person in persons %}"),
          P("{{ person.member }}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    docx = await authorFieldMarkers(docx, [
      { path: "persons.member", label: "Member", required: true },
    ]);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
      const { safeDb, scopedDb } = stubDb("roster.docx");

      const result = await Result.gen(() =>
        fillByIdLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values: { persons: ["invalid"] } },
          query: {},
          recordAuditEvent,
        }),
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(HandlerError.is(result.error) && result.error.status).toBe(400);
      }
    } finally {
      fakeS3.stop();
    }
  });
});

test("stored-template download preserves the typed clause refusal", async () => {
  const docx = await makeDocx(WRAP(P('{{ clause("Terms") }}')));
  const fakeS3 = startFakeS3();
  try {
    fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
    const { safeDb, scopedDb } = stubDb("terms.docx");
    const result = await Result.gen(() =>
      fillByIdLogic({
        safeDb,
        scopedDb,
        organizationId,
        userId,
        templateId,
        body: {
          values: {},
          clauseOverrides: {
            "@clause:Terms": [{ text: "{% else %}", isDirective: true }],
          },
        },
        query: {},
        recordAuditEvent,
      }),
    );
    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result) || !HandlerError.is(result.error)) {
      throw new TypeError("expected typed clause refusal");
    }
    expect(result.error.status).toBe(422);
    expect(result.error.code).toBe("clause_directives_invalid");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("@clause:Terms");
  } finally {
    fakeS3.stop();
  }
});

describe("fillByIdLogic records the completion decision", () => {
  /** A stub that also records the fill row and the audit event the route
   *  writes, so the recorded status can be read back. */
  const recordingDb = (fileName: string) => {
    const rows: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    const db = createScopedDbMock({
      query: {
        templates: {
          findFirst: async () => ({
            name: "Template",
            fileName,
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
    const events: Record<string, unknown>[] = [];
    const recordAudit: AuditRecorder = async (_tx, event) => {
      for (const each of Array.isArray(event) ? event : [event]) {
        audits.push(each.metadata ?? {});
        events.push({ ...each });
      }
      await Promise.resolve();
    };
    return { ...db, rows, audits, events, recordAudit };
  };

  const fillById = async (
    paragraphs: string[],
    values: Record<string, unknown>,
  ) => {
    const docx = await makeDocx(WRAP(paragraphs.map(P).join("")));
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, new Uint8Array(docx.bytes));
      const db = recordingDb("nda.docx");
      const result = await Result.gen(() =>
        fillByIdLogic({
          safeDb: db.safeDb,
          scopedDb: db.scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values },
          query: {},
          recordAuditEvent: db.recordAudit,
        }),
      );
      if (Result.isError(result)) {
        throw new TypeError("expected a filled document", {
          cause: result.error,
        });
      }
      return { db, response: result.value };
    } finally {
      fakeS3.stop();
    }
  };

  test("a directive the renderer could not apply records the fill as partial", async () => {
    const { db, response } = await fillById(
      ["Broken{% if oops %} span without closer."],
      { oops: true },
    );
    expect(db.rows).toHaveLength(1);
    expect(db.rows.at(0)).toMatchObject({ status: "partial" });
    expect(db.audits.at(0)).toMatchObject({ status: "partial" });
    // The message carries characters outside ISO-8859-1, so the header
    // travels URI-encoded instead of failing the download.
    const header = response.additionalHeaders.get("X-Structure-Errors");
    expect(JSON.parse(decodeURIComponent(header ?? "[]"))).toMatchObject([
      { paragraphIndex: 0, directive: "{% if oops %}" },
    ]);
  });

  test("a complete fill records success", async () => {
    const { db } = await fillById(["Governed by {{law}}."], { law: "Czech" });
    expect(db.rows.at(0)).toMatchObject({ status: "success" });
    expect(db.audits.at(0)).toMatchObject({ status: "success" });
  });

  test("the download is audited with the same counts as every other fill surface", async () => {
    const { db } = await fillById(["Governed by {{law}} for {{party}}."], {
      law: "Czech",
      extra: "unused",
    });
    expect(db.rows).toEqual([
      {
        organizationId,
        templateId,
        userId,
        format: "docx",
        status: "partial",
        unmatchedCount: 1,
        unusedCount: 1,
        structureErrors: null,
      },
    ]);
    expect(db.events).toEqual([
      {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        metadata: {
          format: "docx",
          status: "partial",
          unmatchedCount: 1,
          aiFieldErrorCount: 0,
          undecidedConditionCount: 0,
        },
      },
    ]);
  });
});
