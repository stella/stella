import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  MANIFEST_NS,
  readManifest,
  stripManifest,
  writeManifest,
} from "./template-manifest";
import type { TemplateManifest } from "./types";

/**
 * Regression: uploading a real Word/Google-Docs DOCX used to fail with
 * "Nepodařilo se uložit vzor / Došlo k neočekávané chybě" (PUT /v1/templates/
 * 500, Panic ← WorkflowValidationError). Such documents ship their own custom
 * XML data store at the hardcoded `customXml/item1.xml` slot (bibliography
 * sources, custom doc properties, content-control bindings, SharePoint
 * metadata), and the manifest writer refused to allocate a different slot.
 */

const FOREIGN_ITEM1 =
  '<b:Sources SelectedStyle="/APA.XSL" StyleName="APA" xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"></b:Sources>';
const UNSAFE_MANIFEST_INDEX = "9007199254740992";

/** A DOCX that already occupies custom XML slot 1 with a foreign part, mirroring
 *  a Word document that carries a bibliography data store. */
const createDocxWithForeignCustomXml = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello {{clientName}}</w:t></w:r></w:p></w:body></w:document>',
  );
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/></Types>',
  );
  zip.file("customXml/item1.xml", FOREIGN_ITEM1);
  zip.file(
    "customXml/itemProps1.xml",
    '<?xml version="1.0"?><ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{FOREIGN}"/>',
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const sampleManifest: TemplateManifest = {
  version: 1,
  fields: [{ path: "clientName", label: "Client Name", inputType: "text" }],
};

const readZipText = async (zip: JSZip, path: string): Promise<string> => {
  const entry = zip.file(path);
  if (entry === null) {
    throw new Error(`Missing ${path}`);
  }

  return entry.async("string");
};

const createDocxWithUnsafeManifestSlot = async (): Promise<Buffer> => {
  const base = new JSZip();
  base.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello {{clientName}}</w:t></w:r></w:p></w:body></w:document>',
  );
  base.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
  );

  const written = await writeManifest(
    Buffer.from(await base.generateAsync({ type: "nodebuffer" })),
    sampleManifest,
  );
  const zip = await JSZip.loadAsync(written);
  const manifestXml = await readZipText(zip, "customXml/item1.xml");
  const propsXml = await readZipText(zip, "customXml/itemProps1.xml");
  const relsXml = await readZipText(zip, "customXml/_rels/item1.xml.rels");
  const contentTypesXml = await readZipText(zip, "[Content_Types].xml");

  zip.remove("customXml/item1.xml");
  zip.remove("customXml/itemProps1.xml");
  zip.remove("customXml/_rels/item1.xml.rels");
  zip.file(`customXml/item${UNSAFE_MANIFEST_INDEX}.xml`, manifestXml);
  zip.file(`customXml/itemProps${UNSAFE_MANIFEST_INDEX}.xml`, propsXml);
  zip.file(
    `customXml/_rels/item${UNSAFE_MANIFEST_INDEX}.xml.rels`,
    relsXml.replaceAll(
      "itemProps1.xml",
      () => `itemProps${UNSAFE_MANIFEST_INDEX}.xml`,
    ),
  );
  zip.file(
    "[Content_Types].xml",
    contentTypesXml.replaceAll(
      "itemProps1.xml",
      () => `itemProps${UNSAFE_MANIFEST_INDEX}.xml`,
    ),
  );

  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

describe("writeManifest with a foreign custom XML slot", () => {
  test("writes to a free slot, preserving the foreign part, and round-trips", async () => {
    const docx = await createDocxWithForeignCustomXml();

    const withManifest = await writeManifest(docx, sampleManifest);

    // Manifest is readable again (located by namespace, not a fixed slot).
    expect(await readManifest(withManifest)).toEqual(sampleManifest);

    const zip = await JSZip.loadAsync(withManifest);

    // Foreign item1 is untouched; the manifest landed in the next slot.
    expect(await zip.file("customXml/item1.xml")?.async("string")).toBe(
      FOREIGN_ITEM1,
    );
    const item2 = await zip.file("customXml/item2.xml")?.async("string");
    expect(item2).toContain(MANIFEST_NS);

    // Both props parts get their own Content_Types override.
    const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
    expect(contentTypes).toContain('PartName="/customXml/itemProps1.xml"');
    expect(contentTypes).toContain('PartName="/customXml/itemProps2.xml"');

    // The manifest's relationship targets its own props part.
    const rels = await zip
      .file("customXml/_rels/item2.xml.rels")
      ?.async("string");
    expect(rels).toContain('Target="itemProps2.xml"');
  });

  test("re-saving reuses the manifest's existing slot (idempotent)", async () => {
    const docx = await createDocxWithForeignCustomXml();
    const once = await writeManifest(docx, sampleManifest);
    const twice = await writeManifest(once, sampleManifest);

    const zip = await JSZip.loadAsync(twice);
    // No new slot is allocated on re-save: still item2, no item3.
    expect(zip.file("customXml/item2.xml")).not.toBeNull();
    expect(zip.file("customXml/item3.xml")).toBeNull();
    expect(await readManifest(twice)).toEqual(sampleManifest);
  });

  // A part that merely mentions the namespace URI (e.g. as text) is NOT a
  // manifest: detection parses the root element, it is not a substring match.
  test("ignores a foreign part that only mentions the namespace string", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    // Foreign part: contains the URN as text but the root is not <template>.
    const decoy = `<note>see ${MANIFEST_NS} for details</note>`;
    zip.file("customXml/item1.xml", decoy);
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(await readManifest(buf)).toBeNull();

    const withManifest = await writeManifest(buf, sampleManifest);
    const out = await JSZip.loadAsync(withManifest);
    // The decoy is preserved; the real manifest landed in a fresh slot.
    expect(await out.file("customXml/item1.xml")?.async("string")).toBe(decoy);
    expect(await readManifest(withManifest)).toEqual(sampleManifest);
  });

  // A `<template>` element that merely *declares* our namespace prefix but is
  // not itself in the namespace is not a manifest (the root's namespaceURI,
  // not a stray xmlns:st attribute, decides).
  test("ignores a foreign <template> not actually in the namespace", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    const decoy = `<template xmlns:st="${MANIFEST_NS}"><fields/></template>`;
    zip.file("customXml/item1.xml", decoy);
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(await readManifest(buf)).toBeNull();

    const withManifest = await writeManifest(buf, sampleManifest);
    const out = await JSZip.loadAsync(withManifest);
    expect(await out.file("customXml/item1.xml")?.async("string")).toBe(decoy);
    expect(await readManifest(withManifest)).toEqual(sampleManifest);
  });

  // When a valid manifest sits in a higher slot than a foreign part, it is
  // still found, and re-save reuses that slot rather than item1.
  test("finds a manifest in a non-first slot deterministically", async () => {
    const base = await createDocxWithForeignCustomXml();
    const withManifest = await writeManifest(base, sampleManifest); // → item2
    expect(await readManifest(withManifest)).toEqual(sampleManifest);

    const resaved = await writeManifest(withManifest, sampleManifest);
    const zip = await JSZip.loadAsync(resaved);
    expect(zip.file("customXml/item3.xml")).toBeNull();
    expect(await zip.file("customXml/item2.xml")?.async("string")).toContain(
      MANIFEST_NS,
    );
  });

  // The manifest (field schema, AI prompts) must never ride along in a filled
  // document. stripManifest has to remove it from whatever slot it occupies,
  // not just item1 — otherwise a relocated manifest would leak on fill.
  test("stripManifest removes the manifest from a non-first slot", async () => {
    const base = await createDocxWithForeignCustomXml();
    const withManifest = await writeManifest(base, sampleManifest); // → item2

    const stripped = await stripManifest(withManifest);

    // No custom XML part carries the Stella namespace anymore.
    expect(await readManifest(stripped)).toBeNull();
    const zip = await JSZip.loadAsync(stripped);
    expect(zip.file("customXml/item2.xml")).toBeNull();
    expect(zip.file("customXml/itemProps2.xml")).toBeNull();
    const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
    expect(contentTypes).not.toContain("itemProps2.xml");

    // The foreign part is left untouched.
    expect(await zip.file("customXml/item1.xml")?.async("string")).toBe(
      FOREIGN_ITEM1,
    );
  });

  test("ignores unsafe custom XML slot indexes when choosing where to write the manifest", async () => {
    const zip = new JSZip();
    const hugeIndex = "9".repeat(400);
    zip.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    zip.file(`customXml/item${hugeIndex}.xml`, "<foreign/>");
    const docx = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const withManifest = await writeManifest(docx, sampleManifest);
    const out = await JSZip.loadAsync(withManifest);

    expect(out.file("customXml/itemInfinity.xml")).toBeNull();
    expect(await out.file("customXml/item1.xml")?.async("string")).toContain(
      MANIFEST_NS,
    );
    expect(await readManifest(withManifest)).toEqual(sampleManifest);

    const stripped = await stripManifest(withManifest);
    const strippedZip = await JSZip.loadAsync(stripped);
    expect(await readManifest(stripped)).toBeNull();
    expect(strippedZip.file("customXml/item1.xml")).toBeNull();
    expect(strippedZip.file(`customXml/item${hugeIndex}.xml`)).not.toBeNull();
  });

  test("detects and removes an existing manifest in an unsafe custom XML slot", async () => {
    const docx = await createDocxWithUnsafeManifestSlot();

    expect(await readManifest(docx)).toEqual(sampleManifest);

    const stripped = await stripManifest(docx);
    const strippedZip = await JSZip.loadAsync(stripped);
    expect(await readManifest(stripped)).toBeNull();
    expect(
      strippedZip.file(`customXml/item${UNSAFE_MANIFEST_INDEX}.xml`),
    ).toBeNull();
    expect(
      strippedZip.file(`customXml/itemProps${UNSAFE_MANIFEST_INDEX}.xml`),
    ).toBeNull();
    expect(
      strippedZip.file(`customXml/_rels/item${UNSAFE_MANIFEST_INDEX}.xml.rels`),
    ).toBeNull();
    const strippedContentTypes = await readZipText(
      strippedZip,
      "[Content_Types].xml",
    );
    expect(strippedContentTypes).not.toContain(
      `itemProps${UNSAFE_MANIFEST_INDEX}.xml`,
    );

    const updatedManifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "updated", label: "Updated" }],
    };
    const migrated = await writeManifest(docx, updatedManifest);
    const migratedZip = await JSZip.loadAsync(migrated);
    expect(await readManifest(migrated)).toEqual(updatedManifest);
    expect(migratedZip.file("customXml/item1.xml")).not.toBeNull();
    expect(
      migratedZip.file(`customXml/item${UNSAFE_MANIFEST_INDEX}.xml`),
    ).toBeNull();
    expect(migratedZip.file("customXml/itemInfinity.xml")).toBeNull();
  });

  // A producer may serialize the Content_Types override with single quotes.
  // stripManifest must still remove it; otherwise it deletes the props part
  // but leaves a dangling override pointing at a now-missing part.
  test("stripManifest removes a single-quoted Content_Types override", async () => {
    const base = await createDocxWithForeignCustomXml();
    const written = await writeManifest(base, sampleManifest); // → item2

    // Rewrite our override to single quotes, as a single-quote producer would.
    const inZip = await JSZip.loadAsync(written);
    const ct = await inZip.file("[Content_Types].xml")!.async("string");
    inZip.file(
      "[Content_Types].xml",
      ct.replace(
        /<Override PartName="\/customXml\/itemProps2\.xml"(?<rest>[^>]*)\/>/u,
        "<Override PartName='/customXml/itemProps2.xml'$<rest>/>",
      ),
    );
    const singleQuoted = Buffer.from(
      await inZip.generateAsync({ type: "nodebuffer" }),
    );

    const stripped = await stripManifest(singleQuoted);
    const out = await JSZip.loadAsync(stripped);
    expect(out.file("customXml/itemProps2.xml")).toBeNull();
    const contentTypes = await out.file("[Content_Types].xml")?.async("string");
    // No dangling override to the deleted part remains.
    expect(contentTypes).not.toContain("itemProps2.xml");
  });
});
