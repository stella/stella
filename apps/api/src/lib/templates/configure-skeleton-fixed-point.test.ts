/**
 * The configure skeleton a freshly created template hands back is a fixed
 * point: sending it through `configure_template_fields` unchanged applies
 * every entry, reports no issue, and leaves the manifest exactly as discovery
 * built it. That is what makes "copy this and edit what should differ" safe
 * advice, and it is the property that breaks the moment a bare entry starts
 * recording a decision nobody made.
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { W_NS } from "@/api/lib/docx/ooxml";
import { mergeManifestWithDiscovery } from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import {
  applyFieldOverlay,
  partitionFieldOverlay,
} from "@/api/lib/templates/field-overlay";
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
  "{{#each deliverables}}",
  "{{deliverables.item}} — {{deliverables.fee}}",
  "{{/each}}",
  "{{#if expenses_reimbursed}}",
  "Expenses are reimbursed at cost.",
  "{{/if}}",
];

describe("the configure skeleton is a fixed point", () => {
  test("sending it back unchanged applies every entry and changes nothing", async () => {
    const buffer = await buildDocx(SOURCE_PARAGRAPHS);
    const discovered = await discoverTemplate(buffer);

    // What creation stores: the manifest discovery alone produces.
    const created: TemplateManifest = {
      version: 1,
      fields: mergeManifestWithDiscovery(null, discovered).map(
        (field): FieldMeta => ({ path: field.path }),
      ),
    };

    // The skeleton: one bare person entry per configurable path, loop item
    // paths included, exactly as `create_template` spells it.
    const skeletonPaths = [
      ...created.fields.map((field) => field.path),
      ...discovered.fields.flatMap((field) =>
        (field.itemFields ?? []).map((item) => `${field.path}.${item.path}`),
      ),
    ];
    const skeleton = [...new Set(skeletonPaths)].map((path) =>
      toFieldMetaToolInput({ path, source: { type: "person" } }),
    );

    const { applied, issues } = partitionFieldOverlay({
      configured: created.fields,
      discovered,
      overlay: skeleton,
    });

    expect(issues).toEqual([]);
    expect(applied.length).toBe(skeleton.length);
    expect(applyFieldOverlay(created, applied)).toEqual(created);
  });

  test("the skeleton names the loop item paths, which the manifest does not", async () => {
    const buffer = await buildDocx(SOURCE_PARAGRAPHS);
    const discovered = await discoverTemplate(buffer);
    const manifestPaths = mergeManifestWithDiscovery(null, discovered).map(
      (field) => field.path,
    );

    expect(manifestPaths).not.toContain("deliverables.item");
    // ...but the document declares it, and a configuration may name it.
    expect(
      partitionFieldOverlay({
        configured: [],
        discovered,
        overlay: [{ path: "deliverables.item", label: "Deliverable" }],
      }).issues,
    ).toEqual([]);
  });

  test("an entry that carries a decision does change the manifest", async () => {
    const buffer = await buildDocx(SOURCE_PARAGRAPHS);
    const discovered = await discoverTemplate(buffer);
    const created: TemplateManifest = {
      version: 1,
      fields: mergeManifestWithDiscovery(null, discovered).map(
        (field): FieldMeta => ({ path: field.path }),
      ),
    };

    const configured = applyFieldOverlay(created, [
      { path: "deliverables.item", label: "Deliverable" },
    ]);

    expect(configured.fields).toContainEqual({
      path: "deliverables.item",
      label: "Deliverable",
    });
  });
});
