// eigenpal #424 (w:rtl gap 10 / w:effect gap 11) — round-trip the per-run
// direction flag and the text-effect animation hint through the OOXML parser
// and serializer.

import { describe, expect, test } from "bun:test";

import { TEXT_EFFECT_VALUES } from "../../types/documentEnumValues";
import { parseRunProperties } from "../runParser";
import { serializeTextFormatting } from "../serializer/runSerializer";
import { parseXml } from "../xmlParser";
import type { XmlElement } from "../xmlParser";

function parseRPr(xml: string): XmlElement {
  const doc = parseXml(
    `<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${xml}</w:rPr>`,
  );
  return (doc.elements as XmlElement[])[0];
}

function roundTrip(innerXml: string) {
  const rPr = parseRPr(innerXml);
  const formatting = parseRunProperties(rPr, null);
  const serialized = serializeTextFormatting(formatting);
  return { formatting, serialized };
}

describe("w:rtl run direction round-trip (eigenpal #424 gap 10)", () => {
  test("parses <w:rtl/> as rtl=true", () => {
    const { formatting } = roundTrip("<w:rtl/>");
    expect(formatting?.rtl).toBe(true);
  });

  test('parses <w:rtl w:val="0"/> as rtl=false', () => {
    const { formatting } = roundTrip('<w:rtl w:val="0"/>');
    expect(formatting?.rtl).toBe(false);
  });

  test("serializes rtl=true back to <w:rtl/>", () => {
    const { serialized } = roundTrip("<w:rtl/>");
    expect(serialized).toContain("<w:rtl/>");
  });

  test("round-trips rtl combined with other formatting", () => {
    const { formatting, serialized } = roundTrip(
      '<w:b/><w:rtl/><w:color w:val="FF0000"/>',
    );
    expect(formatting?.rtl).toBe(true);
    expect(formatting?.bold).toBe(true);
    expect(serialized).toContain("<w:rtl/>");
    expect(serialized).toContain("<w:b/>");
    expect(serialized).toContain('w:val="FF0000"');
  });

  test("absent <w:rtl/> leaves rtl undefined", () => {
    const { formatting, serialized } = roundTrip("<w:b/>");
    expect(formatting?.rtl).toBeUndefined();
    expect(serialized).not.toContain("<w:rtl");
  });
});

describe("w:effect text animation round-trip (eigenpal #424 gap 11)", () => {
  // Upstream eigenpal #424 enumerates six active animations plus the explicit
  // "none" sentinel; mirror that union verbatim so host CSS keys (and class
  // names emitted by the PM extension) stay aligned with upstream.
  const expectedEffects = [
    "none",
    "blinkBackground",
    "lights",
    "antsBlack",
    "antsRed",
    "shimmer",
    "sparkle",
  ] as const;

  test("TEXT_EFFECT_VALUES matches the upstream union", () => {
    expect([...TEXT_EFFECT_VALUES]).toEqual([...expectedEffects]);
  });

  for (const effect of expectedEffects) {
    if (effect === "none") {
      continue;
    }
    test(`parses and re-emits <w:effect w:val="${effect}"/>`, () => {
      const { formatting, serialized } = roundTrip(
        `<w:effect w:val="${effect}"/>`,
      );
      expect(formatting?.effect).toBe(effect);
      expect(serialized).toContain(`<w:effect w:val="${effect}"/>`);
    });
  }

  test('drops <w:effect w:val="none"/> on serialize', () => {
    // Upstream skips the no-op sentinel on emit; parser still recognises it.
    const { formatting, serialized } = roundTrip('<w:effect w:val="none"/>');
    expect(formatting?.effect).toBe("none");
    expect(serialized).not.toContain("<w:effect");
  });

  test("ignores unrecognised effect attribute values", () => {
    const { formatting, serialized } = roundTrip(
      '<w:effect w:val="discoInferno"/>',
    );
    expect(formatting?.effect).toBeUndefined();
    expect(serialized).not.toContain("<w:effect");
  });

  test("round-trips effect alongside rtl and other formatting", () => {
    const { formatting, serialized } = roundTrip(
      '<w:i/><w:rtl/><w:effect w:val="shimmer"/>',
    );
    expect(formatting?.italic).toBe(true);
    expect(formatting?.rtl).toBe(true);
    expect(formatting?.effect).toBe("shimmer");
    expect(serialized).toContain("<w:i/>");
    expect(serialized).toContain("<w:rtl/>");
    expect(serialized).toContain('<w:effect w:val="shimmer"/>');
  });
});
