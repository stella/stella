import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  ATTACHED_TEMPLATE_TARGET_KIND,
  classifyAttachedTemplateTarget,
  relationshipSourcePartPath,
  sanitizeAttachedTemplateRelationships,
  sanitizeAttachedTemplateSource,
} from "./attached-template";

const RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const ATTACHED_TEMPLATE_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate";

describe("attached-template target classification", () => {
  test.each([
    ["file:///C:\\Users\\person\\Template\\Contract.dotx", "local"],
    ["file:///Users/person/Template/Contract.dotx", "local"],
    ["file://localhost/C:/Templates/Contract.dotx", "local"],
    ["file:////fileserver/Templates/Contract.dotx", "network"],
    ["C:\\Templates\\Contract.dotx", "local"],
    ["../Templates/Contract.dotx", "local"],
    ["https://example.test/Contract.dotm", "network"],
    ["smb://files.example.test/Templates/Contract.dotx", "network"],
    ["file://fileserver/Templates/Contract.dotx", "network"],
    ["\\\\fileserver\\Templates\\Contract.dotx", "network"],
    ["//fileserver/Templates/Contract.dotx", "network"],
    ["", "unknown"],
    [null, "unknown"],
  ] as const)("classifies %p as %s", (target, expected) => {
    expect(classifyAttachedTemplateTarget(target)).toBe(expected);
  });
});

describe("relationship source paths", () => {
  test.each([
    ["word/_rels/settings.xml.rels", "word/settings.xml"],
    ["customXml/_rels/item1.xml.rels", "customXml/item1.xml"],
    ["_rels/document.xml.rels", "document.xml"],
    ["_rels/.rels", null],
    ["word/settings.xml", null],
  ] as const)("resolves %s", (path, expected) => {
    expect(relationshipSourcePartPath(path)).toBe(expected);
  });
});

describe("attached-template relationship sanitization", () => {
  test("classifies the actual local-template shape without confusing the Type URI for a remote target", () => {
    const xml =
      `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NS}">` +
      `<Relationship Id="rId1" Type="${ATTACHED_TEMPLATE_TYPE}" ` +
      'Target="file:///C:\\Users\\person\\Template\\Contract.dotx" TargetMode="External"/>' +
      "</Relationships>";

    const result = sanitizeAttachedTemplateRelationships(
      xml,
      "word/_rels/settings.xml.rels",
    );

    expect(result.findings).toEqual([
      {
        rule: ATTACHED_TEMPLATE_SECURITY_RULE,
        targetKind: ATTACHED_TEMPLATE_TARGET_KIND.local,
      },
    ]);
    expect(result.sourcePartPath).toBe("word/settings.xml");
    expect(result.xml).not.toContain("attachedTemplate");
    expect(() => slimdom.parseXmlDocument(result.xml)).not.toThrow();
  });

  test("supports strict OOXML, single quotes, and reordered attributes", () => {
    const xml =
      `<Relationships xmlns='${RELATIONSHIPS_NS}'>` +
      "<Relationship TargetMode='External' Target='https://example.test/a.dotm' " +
      "Type='http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate' Id='rId9'/>" +
      "</Relationships>";

    const result = sanitizeAttachedTemplateRelationships(
      xml,
      "word/_rels/settings.xml.rels",
    );

    expect(result.findings).toEqual([
      {
        rule: ATTACHED_TEMPLATE_SECURITY_RULE,
        targetKind: ATTACHED_TEMPLATE_TARGET_KIND.network,
      },
    ]);
  });

  test("preserves unrelated relationships and returns clean XML unchanged", () => {
    const xml =
      `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NS}">` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
      'Target="https://example.test" TargetMode="External"/>' +
      "</Relationships>";

    const result = sanitizeAttachedTemplateRelationships(
      xml,
      "word/_rels/document.xml.rels",
    );

    expect(result.findings).toEqual([]);
    expect(result.xml).toBe(xml);
  });
});

describe("attached-template source sanitization", () => {
  test("removes all attached-template references and preserves other settings", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/>' +
      '<w:attachedTemplate r:id="rId2"/></w:settings>';

    const first = sanitizeAttachedTemplateSource(xml);
    const second = sanitizeAttachedTemplateSource(first.xml);

    expect(first.removed).toBe(2);
    expect(first.xml).toContain("w:zoom");
    expect(first.xml).not.toContain("attachedTemplate");
    expect(second).toEqual({ removed: 0, xml: first.xml });
    expect(() => slimdom.parseXmlDocument(first.xml)).not.toThrow();
  });
});
