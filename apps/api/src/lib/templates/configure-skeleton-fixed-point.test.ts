/**
 * The configure skeleton a freshly created template hands back is a fixed
 * point: sending it through `configure_template_fields` unchanged applies
 * every entry, reports no issue, and leaves the manifest exactly as the
 * document already declared it. That is what makes "copy this and edit what
 * should differ" safe advice, and it is the property that breaks the moment a
 * bare entry starts recording a decision nobody made.
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { deriveManifest } from "@/api/lib/docx/derived-manifest";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { W_NS } from "@/api/lib/docx/ooxml";
import type { FieldMeta } from "@/api/lib/docx/types";
import { partitionFieldConfiguration } from "@/api/lib/templates/configure-field-input";
import { configureTemplateDocument } from "@/api/lib/templates/configure-template-document";
import { toFieldMetaToolInput } from "@/api/mcp/template-field-input";

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

const buildDocx = async (paragraphs: readonly string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.map(paragraph).join("")}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

/** A statement of work with a plain field, a loop and its item fields, and a
 *  conditional block: every path shape the skeleton has to spell. */
const SOURCE_PARAGRAPHS = [
  "Statement of Work for {{client_name}}",
  "{% for deliverable in deliverables %}",
  "{{ deliverable.item }} — {{ deliverable.fee }}",
  "{% endfor %}",
  "{% if expenses_reimbursed %}",
  "Expenses are reimbursed at cost.",
  "{% endif %}",
];

/** What `create_template` hands back: one bare person entry per configurable
 *  path, loop item paths included. */
const documentText = async (docx: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(docx);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
};

const skeletonFor = (paths: readonly string[]): FieldMeta[] =>
  [...new Set(paths)].map((path) =>
    toFieldMetaToolInput({ path, source: { type: "person" } }),
  );

describe("the configure skeleton is a fixed point", () => {
  test("sending it back unchanged applies every entry and decides nothing", async () => {
    const discovered = await discoverTemplate(
      await buildDocx(SOURCE_PARAGRAPHS),
    );
    // What creation stores: the manifest the document itself declares.
    const created = deriveManifest(discovered);
    const skeleton = skeletonFor([
      ...created.fields.map((field) => field.path),
      ...discovered.fields.flatMap((field) =>
        (field.itemFields ?? []).map((item) => `${field.path}.${item.path}`),
      ),
    ]);

    const { applied, issues } = partitionFieldConfiguration({
      configured: created.fields,
      discovered,
      entries: skeleton,
    });

    expect(issues).toEqual([]);
    expect(applied.map(({ field }) => field.path).toSorted()).toEqual(
      skeleton.map((field) => field.path).toSorted(),
    );
    // A bare person entry is a description of the path, not a decision about
    // it: nothing but the path survives the boundary, so merging the skeleton
    // onto the manifest leaves every field as the document declared it.
    for (const { field } of applied) {
      expect(field).toEqual({ path: field.path });
    }
  });

  test("sending it back publishes no document and reports no issue", async () => {
    const document = await buildDocx(SOURCE_PARAGRAPHS);
    const discovered = await discoverTemplate(document);
    const created = deriveManifest(discovered);
    const skeleton = skeletonFor([
      ...created.fields.map((field) => field.path),
      ...discovered.fields.flatMap((field) =>
        (field.itemFields ?? []).map((item) => `${field.path}.${item.path}`),
      ),
    ]);

    const configured = await configureTemplateDocument({
      buffer: document,
      entries: skeleton,
    });

    // `expenses_reimbursed` is a boolean because an `{% if %}` reads it, and it
    // has no marker to restate that in: an entry that asks for what the
    // document already says must not be refused for having nowhere to write it.
    expect(configured.issues).toEqual([]);
    expect(configured.buffer).toBe(document);
    expect(configured.manifest).toEqual(created);
  });

  test("a configuration nothing in the document can carry is refused by name", async () => {
    const document = await buildDocx(SOURCE_PARAGRAPHS);

    const configured = await configureTemplateDocument({
      buffer: document,
      entries: [{ path: "expenses_reimbursed", label: "Reimbursed?" }],
    });

    expect(configured.buffer).toBe(document);
    expect(configured.issues.map(({ message }) => message)).toEqual([
      '"expenses_reimbursed" has nothing in the document to carry its configuration.',
    ]);
  });

  test("a rule goes into the {% if %} tag that reads the path", async () => {
    const document = await buildDocx(SOURCE_PARAGRAPHS);

    const configured = await configureTemplateDocument({
      buffer: document,
      entries: [
        { path: "expenses_reimbursed", condition: 'client_name == "ACME"' },
      ],
    });

    expect(configured.issues).toEqual([]);
    expect(await documentText(configured.buffer)).toContain(
      '{% if client_name == "ACME" %}',
    );
    // The rule is the tag's now, so the name it used to hang on is gone and
    // the paths the expression reads are what gates the block.
    const discovered = await discoverTemplate(configured.buffer);
    expect(discovered.conditionPaths).toEqual(["client_name"]);
    expect(configured.manifest.fields.map(({ path }) => path)).not.toContain(
      "expenses_reimbursed",
    );
  });

  test("a lookup on a field nothing prints bare rides its renderings", async () => {
    const document = await buildDocx([
      "Buyer: {{ company.name }}, KRS {{ company.krs }}",
    ]);

    const configured = await configureTemplateDocument({
      buffer: document,
      entries: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "name", template: "[name]" },
              { key: "krs", template: "[krs]" },
            ],
          },
        },
      ],
    });

    expect(configured.issues).toEqual([]);
    // Written onto both renderings, and read back as the one field the lookup
    // fills: the dotted markers are how it prints, not fields of their own.
    expect(await documentText(configured.buffer)).toContain(
      'lookup("krs", name="[name]", krs="[krs]")',
    );
    const company = configured.manifest.fields.find(
      ({ path }) => path === "company",
    );
    expect(company?.lookup?.registry).toBe("krs");
    expect(configured.manifest.fields.map(({ path }) => path)).not.toContain(
      "company.name",
    );
  });

  test("a lookup whose formats render no marker is refused at the boundary", async () => {
    const document = await buildDocx(["Buyer: {{ company.name }}"]);

    const configured = await configureTemplateDocument({
      buffer: document,
      entries: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [{ key: "street", template: "[street]" }],
          },
        },
      ],
    });

    expect(configured.buffer).toBe(document);
    expect(configured.issues.map(({ message }) => message)).toEqual([
      '"company" has no marker to carry its lookup: the DOCX groups ' +
        "{{company.name}} under it, and none of them is a format the lookup renders.",
    ]);
  });
  test("the skeleton names the loop item paths, which the manifest does not", async () => {
    const discovered = await discoverTemplate(
      await buildDocx(SOURCE_PARAGRAPHS),
    );

    expect(
      deriveManifest(discovered).fields.map(({ path }) => path),
    ).not.toContain("deliverables.item");
    // ...but the document declares it, and a configuration may name it.
    expect(
      partitionFieldConfiguration({
        configured: [],
        discovered,
        entries: [{ path: "deliverables.item", label: "Deliverable" }],
      }).issues,
    ).toEqual([]);
  });

  test("an entry that carries a decision keeps it", async () => {
    const discovered = await discoverTemplate(
      await buildDocx(SOURCE_PARAGRAPHS),
    );

    const { applied } = partitionFieldConfiguration({
      configured: deriveManifest(discovered).fields,
      discovered,
      entries: [{ path: "deliverables.item", label: "Deliverable" }],
    });

    expect(applied.map(({ field }) => field)).toEqual([
      { path: "deliverables.item", label: "Deliverable" },
    ]);
  });
});
