/**
 * Regression fixtures for the two documents the authoring eval's models
 * actually wrote when asked for a repeating list: the loop over its own
 * paragraphs, and the loop confined to a table row. Both address an item's
 * field by the loop path plus the field name (`{{attorneys.name}}`,
 * `{{deliverables.item}}`), which is the spelling the marker reference
 * teaches, and both must be configurable at exactly that path.
 *
 * The manifest merge folds a loop's item paths into their array root and
 * drops them, so a validator built on the merged path list refuses
 * `attorneys.name` even though the document declares it. Discovery, the
 * overlay validator, and the field vocabulary an agent is told to use have to
 * agree; these fixtures pin that they do.
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { W_NS } from "@/api/lib/docx/ooxml";
import { partitionFieldOverlay } from "@/api/lib/templates/field-overlay";

type Block =
  | { type: "paragraph"; text: string }
  | { type: "table"; rows: readonly (readonly string[])[] };

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

// A newline inside a cell starts a new paragraph, exactly as the fill
// pipeline reads it.
const cell = (text: string): string =>
  `<w:tc>${text.split("\n").map(paragraph).join("")}</w:tc>`;

const blockXml = (block: Block): string =>
  block.type === "paragraph"
    ? paragraph(block.text)
    : `<w:tbl>${block.rows
        .map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`)
        .join("")}</w:tbl>`;

const buildDocx = async (blocks: readonly Block[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="${W_NS}"><w:body>${blocks.map(blockXml).join("")}</w:body></w:document>`,
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

/** The bilingual power of attorney: one `{{#each}}` per language section,
 *  each opener and closer in a paragraph of its own. */
const POWER_OF_ATTORNEY: readonly Block[] = [
  { type: "paragraph", text: "PEŁNOMOCNICTWO / POWER OF ATTORNEY" },
  {
    type: "paragraph",
    text: "{{company}}, z siedzibą przy {{company.address}}, KRS {{company.krs}},",
  },
  { type: "paragraph", text: "niniejszym ustanawia pełnomocnikami:" },
  { type: "paragraph", text: "{{#each attorneys}}" },
  { type: "paragraph", text: "{{attorneys.name}}" },
  { type: "paragraph", text: "{{/each}}" },
  { type: "paragraph", text: "hereby appoints as its attorneys:" },
  { type: "paragraph", text: "{{#each attorneys}}" },
  { type: "paragraph", text: "{{attorneys.name}}" },
  { type: "paragraph", text: "{{/each}}" },
  { type: "paragraph", text: "Zakres pełnomocnictwa: {{scope}}." },
  { type: "paragraph", text: "Warszawa, dnia {{signing_date}} r." },
];

/** The statement of work: the deliverables loop confined to one table row,
 *  its opener prefixing the first cell and its closer suffixing the last. */
const STATEMENT_OF_WORK: readonly Block[] = [
  { type: "paragraph", text: "Statement of Work for {{client_name}}" },
  {
    type: "table",
    rows: [
      ["Deliverable", "Due date", "Fee"],
      [
        "{{#each deliverables}}{{deliverables.item}}",
        "{{deliverables.due_date}}",
        "{{deliverables.fee}}{{/each}}",
      ],
    ],
  },
];

const configurablePaths = async (
  blocks: readonly Block[],
  paths: readonly string[],
) => {
  const discovered = await discoverTemplate(await buildDocx(blocks));
  return {
    discovered,
    partition: partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: paths.map((path) => ({ path, label: path })),
    }),
  };
};

describe("loop item paths configure the way they are discovered", () => {
  test("an {{#each}} over its own paragraphs declares the prefixed item path", async () => {
    const { discovered, partition } = await configurablePaths(
      POWER_OF_ATTORNEY,
      ["company", "attorneys", "attorneys.name", "scope", "signing_date"],
    );

    expect(discovered.structureErrors).toEqual([]);
    expect(
      discovered.fields.find((field) => field.path === "attorneys"),
    ).toMatchObject({
      kind: "array",
      itemFields: [{ path: "name", kind: "string" }],
    });
    expect(partition.issues).toEqual([]);
    expect(partition.applied.map((field) => field.path)).toEqual([
      "company",
      "attorneys",
      "attorneys.name",
      "scope",
      "signing_date",
    ]);
  });

  test("a row-confined {{#each}} declares the same prefixed item paths", async () => {
    const { discovered, partition } = await configurablePaths(
      STATEMENT_OF_WORK,
      [
        "client_name",
        "deliverables",
        "deliverables.item",
        "deliverables.due_date",
        "deliverables.fee",
      ],
    );

    expect(discovered.structureErrors).toEqual([]);
    expect(
      discovered.fields.find((field) => field.path === "deliverables"),
    ).toMatchObject({
      kind: "array",
      itemFields: [{ path: "due_date" }, { path: "fee" }, { path: "item" }],
    });
    expect(partition.issues).toEqual([]);
  });

  test("a path the document does not declare is the only entry refused", async () => {
    const { partition } = await configurablePaths(POWER_OF_ATTORNEY, [
      "attorneys.name",
      "attorneys.bar_number",
      "scope",
    ]);

    expect(partition.applied.map((field) => field.path)).toEqual([
      "attorneys.name",
      "scope",
    ]);
    expect(partition.issues).toEqual([
      {
        path: "fields.1",
        index: 1,
        message: "No marker {{attorneys.bar_number}} in the DOCX.",
        hint:
          "Configure only the paths the template reported. To add a field, " +
          "put its {{marker}} in the document and publish a new version.",
      },
    ]);
  });
});
