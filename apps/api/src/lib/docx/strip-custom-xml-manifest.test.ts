import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { stripManifest } from "./strip-custom-xml-manifest";

/**
 * The markers carry a template's field configuration, so nothing writes a
 * custom XML manifest any more. Documents authored before the cutover still
 * hold one, and a filled document must not carry template metadata (field
 * schema, AI prompts) out of the workspace, so the fill pipeline strips it.
 *
 * The fixtures below author the legacy part directly: the writer is gone, and
 * a stripper that only works against parts a live writer produced is a
 * stripper that never meets the documents it exists for.
 */

const MANIFEST_NS = "urn:stella:template:v1";

const LEGACY_MANIFEST_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<template xmlns="${MANIFEST_NS}" version="1">` +
  `<fields><field path="clientName" label="Client Name"/></fields>` +
  `</template>`;

const PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.customXmlProperties+xml";

/** A Word bibliography data store: the foreign custom XML part real documents
 *  ship at the slot the manifest writer used to claim. */
const FOREIGN_ITEM1 =
  '<b:Sources SelectedStyle="/APA.XSL" StyleName="APA" xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"></b:Sources>';

const DOCUMENT_XML =
  '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:body><w:p><w:r><w:t>Hello {{clientName}}</w:t></w:r></w:p></w:body></w:document>";

const CONTENT_TYPES_HEAD =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';

const contentTypes = (...overrides: readonly string[]): string => {
  const declared = overrides
    .map(
      (path) =>
        `<Override PartName="/customXml/${path}" ContentType="${PROPS_CONTENT_TYPE}"/>`,
    )
    .join("");
  return `${CONTENT_TYPES_HEAD}${declared}</Types>`;
};

type CustomXmlPart = { index: string; xml: string; withProps?: boolean };

/** A DOCX carrying the given custom XML slots. A slot written `withProps`
 *  gets the props part, its relationship and its Content_Types override, the
 *  way the legacy writer laid a manifest down. */
const buildDocx = async (
  ...parts: readonly CustomXmlPart[]
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file(
    "[Content_Types].xml",
    contentTypes(
      ...parts
        .filter(({ withProps }) => withProps === true)
        .map(({ index }) => `itemProps${index}.xml`),
    ),
  );
  for (const { index, withProps, xml } of parts) {
    zip.file(`customXml/item${index}.xml`, xml);
    if (withProps !== true) {
      continue;
    }
    zip.file(
      `customXml/itemProps${index}.xml`,
      '<?xml version="1.0"?><ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{SLOT}"/>',
    );
    zip.file(
      `customXml/_rels/item${index}.xml.rels`,
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps${index}.xml"/>` +
        "</Relationships>",
    );
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const partText = async (
  docx: Buffer,
  path: string,
): Promise<string | undefined> => {
  const zip = await JSZip.loadAsync(docx);
  return zip.file(path)?.async("string");
};

const customXmlPaths = async (docx: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(docx);
  return Object.keys(zip.files)
    .filter((path) => path.startsWith("customXml/") && !path.endsWith("/"))
    .toSorted();
};

describe("stripping the legacy custom XML manifest", () => {
  // A relocated manifest used to survive a fill because the stripper only
  // looked at item1: the slot a document happens to use is not the contract.
  test.each([
    ["the first slot", "1"],
    ["a slot beside a foreign part", "2"],
    ["a slot whose index exceeds a safe integer", "9007199254740992"],
    ["a slot whose index is 400 digits long", "9".repeat(400)],
  ])("removes a manifest in %s", async (_name, index) => {
    const foreign: CustomXmlPart[] =
      index === "1"
        ? []
        : [{ index: "1", xml: FOREIGN_ITEM1, withProps: true }];
    const docx = await buildDocx(...foreign, {
      index,
      xml: LEGACY_MANIFEST_XML,
      withProps: true,
    });

    const stripped = await stripManifest(docx);

    expect(await customXmlPaths(stripped)).toEqual(
      await customXmlPaths(await buildDocx(...foreign)),
    );
    expect(await partText(stripped, "[Content_Types].xml")).not.toContain(
      `itemProps${index}.xml`,
    );
    // A foreign part beside it keeps both its data and its override.
    if (foreign.length > 0) {
      expect(await partText(stripped, "customXml/item1.xml")).toBe(
        FOREIGN_ITEM1,
      );
      expect(await partText(stripped, "[Content_Types].xml")).toContain(
        "itemProps1.xml",
      );
    }
  });

  // Detection parses the root element; it is not a substring match, so a part
  // that merely names the URN is somebody else's data.
  test.each([
    ["mentions the namespace as text", `<note>see ${MANIFEST_NS}</note>`],
    [
      "declares the namespace on a prefix it does not use",
      `<template xmlns:st="${MANIFEST_NS}"><fields/></template>`,
    ],
    ["is a Word bibliography store", FOREIGN_ITEM1],
  ])("leaves a foreign part that %s", async (_name, xml) => {
    const docx = await buildDocx({ index: "1", xml });

    const stripped = await stripManifest(docx);

    // Nothing was removed, so the same bytes come back.
    expect(stripped).toBe(docx);
    expect(await partText(stripped, "customXml/item1.xml")).toBe(xml);
  });

  test("a document with no custom XML at all comes back unchanged", async () => {
    const docx = await buildDocx();

    expect(await stripManifest(docx)).toBe(docx);
  });

  // Deleting the props part while leaving its override behind points
  // Content_Types at a part that is no longer in the package.
  test("removes the Content_Types override however the producer quoted it", async () => {
    const docx = await buildDocx(
      { index: "1", xml: FOREIGN_ITEM1, withProps: true },
      { index: "2", xml: LEGACY_MANIFEST_XML, withProps: true },
    );
    const zip = await JSZip.loadAsync(docx);
    const declared = await zip.file("[Content_Types].xml")!.async("string");
    zip.file(
      "[Content_Types].xml",
      declared.replace(
        /<Override PartName="\/customXml\/itemProps2\.xml"(?<rest>[^>]*)\/>/u,
        "<Override PartName='/customXml/itemProps2.xml'$<rest>/>",
      ),
    );
    const singleQuoted = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(await partText(singleQuoted, "[Content_Types].xml")).toContain(
      "'/customXml/itemProps2.xml'",
    );

    const stripped = await stripManifest(singleQuoted);

    expect(
      await partText(stripped, "customXml/itemProps2.xml"),
    ).toBeUndefined();
    expect(await partText(stripped, "[Content_Types].xml")).not.toContain(
      "itemProps2.xml",
    );
  });

  // Two manifests can only mean one document went through two writers; the
  // lowest slot is chosen so the same document strips the same way twice.
  test("removes the lowest-numbered manifest slot deterministically", async () => {
    const docx = await buildDocx(
      { index: "2", xml: LEGACY_MANIFEST_XML, withProps: true },
      { index: "3", xml: LEGACY_MANIFEST_XML, withProps: true },
    );

    const stripped = await stripManifest(docx);

    expect(await customXmlPaths(stripped)).toEqual(
      await customXmlPaths(
        await buildDocx({
          index: "3",
          xml: LEGACY_MANIFEST_XML,
          withProps: true,
        }),
      ),
    );
  });
});
