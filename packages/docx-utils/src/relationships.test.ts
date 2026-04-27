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
