import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  ATTACHED_TEMPLATE_TARGET_KIND,
  classifyAttachedTemplateTarget,
  isOpcRelationshipPartPath,
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

  test.each([
    ["_rels/.rels", true],
    ["_rels/document.xml.rels", true],
    ["word/_rels/settings.xml.rels", true],
    ["notes.rels", false],
    ["word/_rels/.rels", false],
    ["word/../_rels/settings.xml.rels", false],
    ["/word/_rels/settings.xml.rels", false],
    ["word\\_rels\\settings.xml.rels", false],
  ] as const)("classifies OPC relationship part %s as %p", (path, expected) => {
    expect(isOpcRelationshipPartPath(path)).toBe(expected);
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
    expect(result.removedRelationshipIds).toEqual(["rId1"]);
    expect(result.sourcePartPath).toBe("word/settings.xml");
    expect(result.xml).not.toContain("attachedTemplate");
    expect(() => slimdom.parseXmlDocument(result.xml)).not.toThrow();
  });

  test("reads only exact unqualified relationship attributes", () => {
    const xml =
      `<Relationships xmlns="${RELATIONSHIPS_NS}">` +
      '<Relationship xmlns:Type="urn:decoy" xmlns:Target="urn:decoy" ' +
      `Id="rId1" Type="${ATTACHED_TEMPLATE_TYPE}" ` +
      'Target="file:///C:/Templates/Contract.dotx"/>' +
      '<Relationship xmlns:x="urn:decoy" Id="rId2" ' +
      `x:Type="${ATTACHED_TEMPLATE_TYPE}" ` +
      'x:Target="https://example.test/Contract.dotm" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
      'Target="https://example.test"/>' +
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
    expect(result.removedRelationshipIds).toEqual(["rId1"]);
    expect(result.xml).toContain('Id="rId2"');
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
  test("removes only matching WordprocessingML references", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:x="urn:vendor-extension">' +
      '<w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/>' +
      '<w:attachedTemplate r:id="rId2"/><w:attachedTemplate x:id="rId1"/>' +
      '<x:attachedTemplate r:id="rId1"/></w:settings>';

    const first = sanitizeAttachedTemplateSource(xml, ["rId1"]);
    const second = sanitizeAttachedTemplateSource(first.xml, ["rId1"]);

    expect(first.removed).toBe(1);
    expect(first.xml).toContain("w:zoom");
    expect(first.xml).toContain('w:attachedTemplate r:id="rId2"');
    expect(first.xml).toContain('w:attachedTemplate x:id="rId1"');
    expect(first.xml).toContain('x:attachedTemplate r:id="rId1"');
    expect(second).toEqual({ removed: 0, xml: first.xml });
    expect(() => slimdom.parseXmlDocument(first.xml)).not.toThrow();
  });

  test("supports strict WordprocessingML relationship references", () => {
    const xml =
      '<w:settings xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main" ' +
      'xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships">' +
      '<w:attachedTemplate r:id="rId9"/><w:compat/></w:settings>';

    const result = sanitizeAttachedTemplateSource(xml, ["rId9"]);

    expect(result.removed).toBe(1);
    expect(result.xml).not.toContain("attachedTemplate");
    expect(result.xml).toContain("w:compat");
  });
});
