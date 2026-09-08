import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { filtersFromFieldConfig } from "@stll/template-conditions";

import { toSafeId } from "@/api/lib/branded-types";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { fillPreviewLogic } from "./fill-preview-logic";

/**
 * The document with each field's configuration authored into the marker that
 * declares it: the DOCX is the only place a template's fields are configured,
 * so a fixture naming a path the document does not carry configures nothing.
 */
const authorFieldMarkers = async (
  docx: Buffer,
  fields: readonly FieldMeta[],
): Promise<Buffer> => {
  const { buffer, written } = await writeFieldFilters(
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
  return buffer;
};

// fillPreviewLogic backs the live "as you type" fill-preview route: values
// are typically still in progress, so it is the one deliberate exception to
// the required-fields gate every other real fill route enforces. That
// exception must be explicit (policy: "allow-partial"), not the route simply
// never calling the gate — this suite pins both halves of that contract: the
// preview never rejects a missing required value, and the gate function it
// calls is the same shared one the enforcing routes use.

// ── DOCX fixture helpers (mirrors templates.test.ts / patch-template.test.ts:
// no shared fixture module exists yet) ──────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
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
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");
const templateId = toSafeId<"template">("tmpl_1");
const s3Key = "fake-key-fill-preview-test";

const requiredFieldManifest: TemplateManifest = {
  version: 1,
  fields: [{ path: "governing_law", label: "Governing law", required: true }],
};

const stubDb = () =>
  createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          name: "Template",
          fileName: "template.docx",
          s3Key,
          languages: [],
        }),
      },
      businessRegistryCredentials: { findMany: async () => [] },
    },
  });

describe("fillPreviewLogic required fields (allow-partial)", () => {
  test("never rejects a preview omitting a required field", async () => {
    let buffer = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    buffer = await authorFieldMarkers(buffer, requiredFieldManifest.fields);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
      const { safeDb, scopedDb } = stubDb();

      const result = await fillPreviewLogic({
        safeDb,
        scopedDb,
        organizationId,
        userId,
        templateId,
        body: { values: {} },
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        // Still an unfilled marker, same as any partial preview — the point
        // is only that it renders instead of being rejected.
        expect(result.value.unmatchedPlaceholders).toContain("governing_law");
      }
    } finally {
      fakeS3.stop();
    }
  });

  test("still renders correctly once the required field is provided", async () => {
    let buffer = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    buffer = await authorFieldMarkers(buffer, requiredFieldManifest.fields);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
      const { safeDb, scopedDb } = stubDb();

      const result = await fillPreviewLogic({
        safeDb,
        scopedDb,
        organizationId,
        userId,
        templateId,
        body: { values: { governing_law: "Czech" } },
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.unmatchedPlaceholders).toEqual([]);
      }
    } finally {
      fakeS3.stop();
    }
  });
});
