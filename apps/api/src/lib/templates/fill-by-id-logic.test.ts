import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { fillByIdLogic } from "./fill-by-id-logic";

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
          languages: [],
        }),
      },
      organizationSettings: { findFirst: async () => undefined },
    },
  });

describe("fillByIdLogic required fields", () => {
  test("rejects a fill omitting a required field, with the full structured detail", async () => {
    let buffer = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    buffer = await writeManifest(buffer, requiredFieldManifest);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
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
    let buffer = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
    buffer = await writeManifest(buffer, requiredFieldManifest);

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
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
    let buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
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
    let buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
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
