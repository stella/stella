import { describe, expect, test } from "bun:test";

import { serializeSectionProperties } from "./sectionPropertiesSerializer";

describe("serializeSectionProperties", () => {
  test("keeps titlePg before bidi in sectPr order", () => {
    const xml = serializeSectionProperties({
      titlePg: true,
      bidi: true,
    });

    expect(xml.indexOf("<w:titlePg/>")).toBeGreaterThanOrEqual(0);
    expect(xml.indexOf("<w:bidi/>")).toBeGreaterThan(
      xml.indexOf("<w:titlePg/>"),
    );
  });

  test("does not serialize evenAndOddHeaders inside sectPr", () => {
    const xml = serializeSectionProperties({
      evenAndOddHeaders: true,
      titlePg: true,
    });

    expect(xml).toContain("<w:titlePg/>");
    expect(xml).not.toContain("<w:evenAndOddHeaders/>");
  });
});
