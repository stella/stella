import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { FieldMeta } from "@/api/lib/docx/types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

import {
  describeStoredTemplate,
  fillTemplateDocx,
} from "./template-fill-service";

// ── DOCX fixture helpers (mirrors patch-template.test.ts / templates.test.ts:
// no shared fixture module exists yet, so every suite builds its own) ──────

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

const extractTexts = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/gu)].map(
    (match) => match[1] ?? "",
  );
};

const organizationId = toSafeId<"organization">("org_1");

/** ScopedDb stub covering only what a manifest-carrying fill touches when no
 *  templateId is supplied (clause-slot resolution is skipped): the org
 *  registry-gate read, which `buildIsRegistryEnabledForOrg` always issues
 *  once a manifest is present, even with no lookup field in play. */
const stubScopedDb = (): ScopedDb => {
  const fakeTx = {
    query: {
      organizationSettings: { findFirst: async () => undefined },
    },
  };
  // SAFETY: test stub; the required-fields path under test never reaches
  // clause-slot or template-row queries (no templateId is passed).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx)) as unknown as ScopedDb;
};

const requiredTextField: FieldMeta = {
  path: "governing_law",
  label: "Governing law",
  inputType: "text",
  required: true,
};

const makeManifestDocx = async (fields: FieldMeta[]): Promise<Buffer> => {
  const docx = await makeDocx(WRAP(P("Governed by {{governing_law}} law.")));
  return await writeManifest(docx, { version: 1, fields });
};

describe("fillTemplateDocx required-field rejection", () => {
  test("rejects a fill omitting a required, non-AI-fillable field", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
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
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "" },
      scopedDb: stubScopedDb(),
      organizationId,
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when the required field is whitespace-only", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "   " },
      scopedDb: stubScopedDb(),
      organizationId,
    });

    expect("requiredFieldsRejection" in result).toBe(true);
  });

  test("rejects when a required loop item field is missing in one array row", async () => {
    const buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    const withManifest = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", buffer: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "" }] },
      scopedDb: stubScopedDb(),
      organizationId,
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
    const buffer = await makeDocx(
      WRAP(
        [P("{{#each persons}}"), P("{{persons.member}}"), P("{{/each}}")].join(
          "",
        ),
      ),
    );
    const withManifest = await writeManifest(buffer, {
      version: 1,
      fields: [{ path: "persons.member", label: "Member", required: true }],
    });

    const result = await fillTemplateDocx({
      source: { name: "Roster", fileName: "roster.docx", buffer: withManifest },
      values: { persons: [{ member: "Alice" }, { member: "Bob" }] },
      scopedDb: stubScopedDb(),
      organizationId,
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Alice");
    expect(texts.join("")).toContain("Bob");
  });

  test("fills when the required field is provided", async () => {
    const buffer = await makeManifestDocx([requiredTextField]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: { governing_law: "Czech" },
      scopedDb: stubScopedDb(),
      organizationId,
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Governed by Czech law.");
  });

  test("does not reject a required field that is AI-fillable when omitted; drafts it instead", async () => {
    const buffer = await makeManifestDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        aiPrompt: "The governing law most likely intended by the parties.",
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
      generateAiValue: async () => "Slovak",
    });

    expect("requiredFieldsRejection" in result).toBe(false);
    if (!("buffer" in result)) {
      throw new Error("expected a filled document");
    }
    const texts = await extractTexts(result.buffer);
    expect(texts.join("")).toContain("Governed by Slovak law.");
  });

  test("does not reject a required, source-bound field left unfilled", async () => {
    const buffer = await makeManifestDocx([
      {
        path: "governing_law",
        label: "Governing law",
        inputType: "text",
        required: true,
        source: { kind: "matter", field: "reference" },
      },
    ]);

    const result = await fillTemplateDocx({
      source: { name: "NDA", fileName: "nda.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
    });

    // No matter is bound (no workspaceId), so the source field simply stays
    // unfilled rather than being flagged as a caller-correctable omission.
    expect("requiredFieldsRejection" in result).toBe(false);
  });

  test("does not check required fields on a manifest-less template", async () => {
    const buffer = await makeDocx(WRAP(P("Hello {{name}}.")));

    const result = await fillTemplateDocx({
      source: { name: "Plain", fileName: "plain.docx", buffer },
      values: {},
      scopedDb: stubScopedDb(),
      organizationId,
    });

    expect("requiredFieldsRejection" in result).toBe(false);
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
          }),
        },
      },
    };
    // SAFETY: test stub; describeStoredTemplate only reads the templates row
    // through this scopedDb (S3 is exercised separately below via fake-s3).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx)) as unknown as ScopedDb;
  };

  test("groups an {{#each}} loop over object items under `arrays`, distinct from `fields`", async () => {
    let buffer = await makeDocx(
      WRAP(
        [
          P("{{#each deliverables}}"),
          P("{{deliverables.name}} due {{deliverables.due_date}}"),
          P("{{/each}}"),
        ].join(""),
      ),
    );
    buffer = await writeManifest(buffer, {
      version: 1,
      fields: [
        { path: "deliverables.name", label: "Name", inputType: "text" },
        {
          path: "deliverables.due_date",
          label: "Due date",
          inputType: "date",
        },
      ],
    });

    // describeStoredTemplate loads via S3; exercise it against the fake store.
    const fakeS3 = startFakeS3();
    try {
      fakeS3.put("stella", s3Key, buffer);
      const result = await describeStoredTemplate({
        templateId,
        scopedDb: stubDescribeScopedDb(),
      });

      if ("error" in result) {
        throw new Error(`unexpected error: ${result.error}`);
      }
      expect(result.arrays).toHaveLength(1);
      const group = result.arrays.at(0);
      expect(group?.path).toBe("deliverables");
      expect(group?.itemFieldPaths.toSorted()).toEqual(["due_date", "name"]);
      // The item fields still appear individually in `fields` too.
      expect(result.fields.map((field) => field.path).toSorted()).toEqual([
        "deliverables.due_date",
        "deliverables.name",
      ]);
    } finally {
      fakeS3.stop();
    }
  });
});
