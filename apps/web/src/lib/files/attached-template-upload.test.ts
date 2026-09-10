import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { DOCX_MIME } from "@/lib/consts";

import { prepareAttachedTemplateFile } from "./attached-template-upload";

const ATTACHED_TEMPLATE_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate";
const HYPERLINK_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const makeDocxFile = async ({
  relationships,
  settings,
}: {
  relationships: string;
  settings: string;
}): Promise<File> => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", "<w:document/>");
  zip.file("word/settings.xml", settings);
  zip.file("word/_rels/settings.xml.rels", relationships);
  return new File(
    [await zip.generateAsync({ type: "arraybuffer" })],
    "case.docx",
    {
      type: DOCX_MIME,
      lastModified: 1234,
    },
  );
};

describe("attached-template upload preparation", () => {
  test("removes the relationship and source reference while preserving unrelated relationships", async () => {
    const original = await makeDocxFile({
      relationships:
        "<Relationships>" +
        `<Relationship Id="rId1" Type="${ATTACHED_TEMPLATE_TYPE}" ` +
        'Target="file:///C:\\Users\\person\\Template\\Contract.dotx" TargetMode="External"/>' +
        `<Relationship Id="rId2" Type="${HYPERLINK_TYPE}" ` +
        'Target="https://example.test" TargetMode="External"/>' +
        "</Relationships>",
      settings:
        '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/></w:settings>',
    });

    const prepared = await prepareAttachedTemplateFile(original);

    expect(prepared).not.toBeNull();
    if (prepared === null) {
      throw new Error("Expected an attached-template finding");
    }
    expect(prepared.rule).toBe("ooxml_attached_template");
    expect(prepared.targetKinds).toEqual(["local"]);
    expect(prepared.file.name).toBe(original.name);
    expect(prepared.file.type).toBe(original.type);
    expect(prepared.file.lastModified).toBe(original.lastModified);

    const sanitizedZip = await JSZip.loadAsync(
      await prepared.file.arrayBuffer(),
    );
    const relationships = await sanitizedZip
      .file("word/_rels/settings.xml.rels")
      ?.async("string");
    const settings = await sanitizedZip
      .file("word/settings.xml")
      ?.async("string");
    expect(relationships).not.toContain("attachedTemplate");
    expect(relationships).toContain(HYPERLINK_TYPE);
    expect(settings).not.toContain("attachedTemplate");
    expect(settings).toContain("w:zoom");

    expect(await prepareAttachedTemplateFile(prepared.file)).toBeNull();
  });

  test("does not rewrite a clean DOCX", async () => {
    const original = await makeDocxFile({
      relationships: `<Relationships><Relationship Id="rId2" Type="${HYPERLINK_TYPE}" Target="https://example.test" TargetMode="External"/></Relationships>`,
      settings: '<w:settings xmlns:w="urn:w"><w:zoom/></w:settings>',
    });

    expect(await prepareAttachedTemplateFile(original)).toBeNull();
  });
});
