import { describe, expect, test } from "bun:test";

import {
  ensureContentType,
  ensureRelationship,
  findNextRId,
} from "./relationships";

describe("relationship helpers", () => {
  test("finds the next relationship id after existing unordered ids", () => {
    const relsXml = [
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId2" Type="type-a" Target="a.xml"/>',
      '<Relationship Id="rId10" Type="type-b" Target="b.xml"/>',
      '<Relationship Id="rId7" Type="type-c" Target="c.xml"/>',
      "</Relationships>",
    ].join("");

    expect(findNextRId(relsXml)).toBe("rId11");
  });

  test("starts relationship ids at rId1 when none exist", () => {
    expect(findNextRId("<Relationships></Relationships>")).toBe("rId1");
  });

  test("adds missing content type overrides before the closing Types tag", () => {
    const contentTypesXml = "<Types></Types>";

    expect(
      ensureContentType(
        contentTypesXml,
        "/word/comments.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
      ),
    ).toBe(
      '<Types><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>\n</Types>',
    );
  });

  test("does not duplicate existing content type overrides", () => {
    const contentTypesXml =
      '<Types><Override PartName="/word/comments.xml" ContentType="comments"/></Types>';

    expect(
      ensureContentType(contentTypesXml, "/word/comments.xml", "comments"),
    ).toBe(contentTypesXml);
  });

  test("adds missing relationships before the closing Relationships tag", () => {
    const relsXml = "<Relationships></Relationships>";

    expect(
      ensureRelationship(
        relsXml,
        "rId4",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        "comments.xml",
      ),
    ).toBe(
      '<Relationships><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>\n</Relationships>',
    );
  });

  test("does not duplicate existing relationship ids", () => {
    const relsXml =
      '<Relationships><Relationship Id="rId4" Type="old" Target="old.xml"/></Relationships>';

    expect(ensureRelationship(relsXml, "rId4", "new", "new.xml")).toBe(relsXml);
  });
});

/**
 * Mirrors the package-local `escapeXmlAttribute` helper so tests can compute
 * the expected attribute value independently of the implementation.
 */
const expectedEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

describe("special replacement patterns do not corrupt output", () => {
  // Each of these is treated specially by String.prototype.replace when used
  // inside the *replacement* string (not the search pattern): $& = the whole
  // match, $$ = literal $, $` / $' = text before/after the match, $1 = capture
  // group 1. A naive `.replace(needle, dynamicString)` call would silently
  // splice in the matched/surrounding text instead of the literal value.
  const specialPatterns = ["$&", "$$", "$`", "$'", "$1", "$<name>"];

  describe("ensureContentType", () => {
    for (const pattern of specialPatterns) {
      test(`literal "${pattern}" survives as partName`, () => {
        const contentTypesXml = "<Types></Types>";
        const result = ensureContentType(
          contentTypesXml,
          pattern,
          "text/plain",
        );

        expect(result).toContain(`PartName="${expectedEscape(pattern)}"`);
        expect(result.match(/<\/Types>/gu)).toHaveLength(1);
      });

      test(`literal "${pattern}" survives as contentType`, () => {
        const contentTypesXml = "<Types></Types>";
        const result = ensureContentType(
          contentTypesXml,
          "/word/x.xml",
          pattern,
        );

        expect(result).toContain(`ContentType="${expectedEscape(pattern)}"`);
        expect(result.match(/<\/Types>/gu)).toHaveLength(1);
      });
    }
  });

  describe("ensureRelationship", () => {
    for (const pattern of specialPatterns) {
      test(`literal "${pattern}" survives as type`, () => {
        const relsXml = "<Relationships></Relationships>";
        const result = ensureRelationship(
          relsXml,
          "rId1",
          pattern,
          "target.xml",
        );

        expect(result).toContain(`Type="${expectedEscape(pattern)}"`);
        expect(result.match(/<\/Relationships>/gu)).toHaveLength(1);
      });

      test(`literal "${pattern}" survives as target`, () => {
        const relsXml = "<Relationships></Relationships>";
        const result = ensureRelationship(relsXml, "rId1", "type", pattern);

        expect(result).toContain(`Target="${expectedEscape(pattern)}"`);
        expect(result.match(/<\/Relationships>/gu)).toHaveLength(1);
      });
    }
  });
});

describe("XML attribute escaping", () => {
  test("escapes quotes, ampersands, and angle brackets in ensureContentType", () => {
    const contentTypesXml = "<Types></Types>";
    const result = ensureContentType(
      contentTypesXml,
      `/word/"quoted"<tag>&amp.xml`,
      `text/plain;charset="utf-8"&<x>`,
    );

    expect(result).toContain(
      'PartName="/word/&quot;quoted&quot;&lt;tag&gt;&amp;amp.xml"',
    );
    expect(result).toContain(
      'ContentType="text/plain;charset=&quot;utf-8&quot;&amp;&lt;x&gt;"',
    );
    // No raw quotes, angle brackets, or bare ampersands leaked outside entities.
    expect(result).not.toMatch(/PartName="[^"]*<[^"]*"/u);
    expect(result.match(/<\/Types>/gu)).toHaveLength(1);
  });

  test("escapes quotes, ampersands, and angle brackets in ensureRelationship", () => {
    const relsXml = "<Relationships></Relationships>";
    const result = ensureRelationship(
      relsXml,
      `rId"1"`,
      `http://example.com/type?a=1&b=2`,
      `target<"x">.xml&y`,
    );

    expect(result).toContain('Id="rId&quot;1&quot;"');
    expect(result).toContain('Type="http://example.com/type?a=1&amp;b=2"');
    expect(result).toContain('Target="target&lt;&quot;x&quot;&gt;.xml&amp;y"');
    expect(result.match(/<\/Relationships>/gu)).toHaveLength(1);
  });

  test("does not double-encode already-escaped ampersands within a single call", () => {
    // Order matters: '&' must be escaped before '<'/'>'/'"' so entities
    // introduced by escaping are not themselves re-escaped.
    const contentTypesXml = "<Types></Types>";
    const result = ensureContentType(contentTypesXml, "/word/x.xml", "&quot;");

    expect(result).toContain('ContentType="&amp;quot;"');
  });
});

describe("round-trip sanity", () => {
  test("adding a content type keeps exactly one closing Types tag", () => {
    const contentTypesXml = "<Types></Types>";
    const result = ensureContentType(
      contentTypesXml,
      "/word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    );

    expect(result.match(/<\/Types>/gu)).toHaveLength(1);
    expect(result.startsWith("<Types>")).toBe(true);
    expect(result.endsWith("</Types>")).toBe(true);
  });

  test("adding a relationship keeps exactly one closing Relationships tag", () => {
    const relsXml = "<Relationships></Relationships>";
    const result = ensureRelationship(
      relsXml,
      "rId1",
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      "word/document.xml",
    );

    expect(result.match(/<\/Relationships>/gu)).toHaveLength(1);
    expect(result.startsWith("<Relationships>")).toBe(true);
    expect(result.endsWith("</Relationships>")).toBe(true);
  });

  test("chaining ensureContentType and ensureRelationship with adversarial values stays well-formed", () => {
    let contentTypesXml = "<Types></Types>";
    let relsXml = "<Relationships></Relationships>";

    contentTypesXml = ensureContentType(
      contentTypesXml,
      `/word/$&"evil".xml`,
      `text/plain&$'`,
    );
    relsXml = ensureRelationship(
      relsXml,
      "rId1",
      `type&$1"<x>`,
      `target$\`&"<y>`,
    );

    expect(contentTypesXml.match(/<\/Types>/gu)).toHaveLength(1);
    expect(relsXml.match(/<\/Relationships>/gu)).toHaveLength(1);
    // No unescaped '<' or '"' introduced inside attribute values, i.e. the
    // only '<' characters present are the ones forming real XML tags.
    expect(contentTypesXml.match(/</gu)).toHaveLength(3); // <Types>, <Override .../>, </Types>
    expect(relsXml.match(/</gu)).toHaveLength(3); // <Relationships>, <Relationship .../>, </Relationships>
  });
});
