import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { fillHandler } from "@/api/handlers/templates/fill";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { fillByIdLogic } from "./fill-by-id-logic";
import { fillPreviewLogic } from "./fill-preview-logic";
import type { MissingRequiredField } from "./template-fill-service";
import { fillTemplateDocx } from "./template-fill-service";

// Every fill boundary runs one pipeline (template-fill-service). This suite
// pins what motivated collapsing the route copies into it: a template whose
// required field the caller omitted is rejected identically everywhere — the
// same structured MissingRequiredField list, carrying each field's input type
// and options, whether the caller is an agent (the tools read the service's
// `requiredFieldsRejection` directly), the raw-upload download route, or the
// by-id download route. A route drifting back to its own copy of the sequence
// shows up here as a differing payload, not as a silently invented value.
// fill-to-workspace and the MCP save tool consume the same
// `requiredFieldsRejection` this suite asserts on the service itself.

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
const s3Key = "fake-key-fill-required-fields-parity";

const recordAuditEvent: AuditRecorder = async () => {
  await Promise.resolve();
};

/** A select carries the metadata a plain path would lose: the caller has to
 *  learn the input type and allowed values from the rejection to ask the right
 *  question, so every boundary must report them. */
const manifest: TemplateManifest = {
  version: 1,
  fields: [
    {
      path: "governing_law",
      label: "Governing law",
      inputType: "select",
      options: ["Czech", "Polish"],
      required: true,
    },
  ],
};

const expectedMissingFields: MissingRequiredField[] = [
  {
    path: "governing_law",
    label: "Governing law",
    inputType: "select",
    options: ["Czech", "Polish"],
  },
];

const buildTemplate = async (): Promise<Buffer> =>
  await writeManifest(
    await makeDocx(WRAP(P("Governed by {{governing_law}} law."))),
    manifest,
  );

const stubDb = () =>
  createScopedDbMock({
    query: {
      templates: {
        findFirst: async () => ({
          name: "NDA",
          fileName: "nda.docx",
          s3Key,
          languages: [],
        }),
      },
      organizationSettings: { findFirst: async () => undefined },
    },
  });

/** Serve the fixture from the fake object store for the stored-template
 *  boundaries, which load their source through S3. */
const withStoredTemplate = async <T>(
  buffer: Buffer,
  run: () => Promise<T>,
): Promise<T> => {
  const fakeS3 = startFakeS3();
  try {
    fakeS3.put("stella", s3Key, buffer);
    return await run();
  } finally {
    fakeS3.stop();
  }
};

describe("required-fields rejection is identical at every enforcing fill boundary", () => {
  test("the fill service reports the full structured rejection the tools return", async () => {
    const buffer = await buildTemplate();
    const { scopedDb } = stubDb();

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb,
      organizationId,
      requiredFields: "enforce",
    });

    expect(result).toEqual({ requiredFieldsRejection: expectedMissingFields });
  });

  test("the raw-upload download route returns that same list as missingFields", async () => {
    const buffer = await buildTemplate();
    const { safeDb, scopedDb } = stubDb();

    const response = await fillHandler({
      safeDb,
      scopedDb,
      organizationId,
      userId,
      query: {},
      body: {
        file: new File([new Uint8Array(buffer)], "nda.docx", {
          type: DOCX_MIME_TYPE,
        }),
        values: "{}",
      },
    });

    expect(response.status).toBe(400);
    expect(
      await readTestJson<{
        error: string;
        missingFields: MissingRequiredField[];
      }>(response),
    ).toEqual({
      error: "missing_required_fields",
      missingFields: expectedMissingFields,
    });
  });

  test("the by-id download route carries that same list on its HandlerError", async () => {
    const buffer = await buildTemplate();
    const { safeDb, scopedDb } = stubDb();

    const result = await withStoredTemplate(
      buffer,
      async () =>
        await Result.gen(() =>
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
        ),
    );

    if (!Result.isError(result)) {
      throw new TypeError("Expected the fill to be rejected");
    }
    if (!HandlerError.is(result.error)) {
      throw new TypeError("Expected a HandlerError rejection");
    }
    expect(result.error.status).toBe(400);
    expect(result.error.requiredFields).toEqual(expectedMissingFields);
  });

  test("the live preview renders the same values instead of rejecting them", async () => {
    const buffer = await buildTemplate();
    const { safeDb, scopedDb } = stubDb();

    const result = await withStoredTemplate(
      buffer,
      async () =>
        await fillPreviewLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values: {} },
        }),
    );

    if (!Result.isOk(result)) {
      throw new TypeError("Expected the preview to render");
    }
    // Still an unfilled marker, as any in-progress preview has; the point is
    // that the shared gate lets it through under "allow-partial".
    expect(result.value.unmatchedPlaceholders).toContain("governing_law");
  });

  test("the preview keeps a partially filled document renderable field by field", async () => {
    const buffer = await writeManifest(
      await makeDocx(
        WRAP(P("Governed by {{governing_law}} law, signed {{signing_date}}.")),
      ),
      {
        version: 1,
        fields: [
          ...manifest.fields,
          { path: "signing_date", label: "Signing date", required: true },
        ],
      },
    );
    const { safeDb, scopedDb } = stubDb();

    const result = await withStoredTemplate(
      buffer,
      async () =>
        await fillPreviewLogic({
          safeDb,
          scopedDb,
          organizationId,
          userId,
          templateId,
          body: { values: { governing_law: "Czech" } },
        }),
    );

    if (!Result.isOk(result)) {
      throw new TypeError("Expected the preview to render");
    }
    expect(
      result.value.paragraphs.map((paragraph) => paragraph.text).join("\n"),
    ).toContain("Governed by Czech law");
    expect(result.value.unmatchedPlaceholders).toEqual(["signing_date"]);
  });
});
