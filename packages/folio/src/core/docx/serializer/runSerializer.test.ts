import { describe, expect, test } from "bun:test";

import type { Run } from "../../types/document";
import { serializeRun } from "./runSerializer";

// Issue #417 (eigenpal): image and shape dimension/offset attributes leaked
// floating-point IEEE-754 drift (e.g. cy="495299.99999999994") which Word
// rejects as a corrupt document. The model layer rounds via pixelsToEmu, but
// the serializer must also coerce so a caller that hands us a float can never
// produce an unopenable file.

const FLOAT_INLINE_IMAGE: Run = {
  type: "run",
  content: [
    {
      type: "drawing",
      image: {
        type: "image",
        rId: "rId7",
        size: { width: 5_610_225, height: 495_299.999_999_999_94 },
        wrap: { type: "inline" },
        padding: { top: 0.4, bottom: 0.6, left: 0, right: 0 },
      },
    },
  ],
};

const FLOAT_FLOATING_IMAGE: Run = {
  type: "run",
  content: [
    {
      type: "drawing",
      image: {
        type: "image",
        rId: "rId8",
        size: { width: 1_905_000.000_000_000_2, height: 933_449.999_999_999_9 },
        wrap: {
          type: "square",
          distT: 114_299.999_999_99,
          distB: 0,
          distL: 0,
          distR: 0,
        },
        position: {
          horizontal: {
            relativeTo: "column",
            posOffset: 238_125.000_000_000_03,
          },
          vertical: {
            relativeTo: "paragraph",
            posOffset: 962_024.999_999_999_9,
          },
        },
      },
    },
  ],
};

const FLOAT_BEHIND_IMAGE: Run = {
  type: "run",
  content: [
    {
      type: "drawing",
      image: {
        type: "image",
        rId: "rId9",
        size: { width: 495_299.999_999_999_94, height: 495_299.999_999_999_94 },
        wrap: { type: "behind" },
        position: {
          horizontal: { relativeTo: "page", posOffset: -50.7 },
          vertical: { relativeTo: "page", posOffset: 0 },
        },
      },
    },
  ],
};

const FLOAT_INLINE_SHAPE: Run = {
  type: "run",
  content: [
    {
      type: "shape",
      shape: {
        type: "shape",
        shapeType: "rect",
        size: { width: 1_234_567.89, height: 987_654.321 },
      },
    },
  ],
};

const FLOAT_FLOATING_TEXTBOX: Run = {
  type: "run",
  content: [
    {
      type: "shape",
      shape: {
        type: "shape",
        shapeType: "textBox",
        size: { width: 2_540_000.000_000_1, height: 1_270_000.5 },
        wrap: {
          type: "square",
          distT: 91_440.7,
          distB: 91_440.3,
          distL: 0,
          distR: 0,
        },
        position: {
          horizontal: { relativeTo: "margin", posOffset: 100_000.5 },
          vertical: { relativeTo: "paragraph", posOffset: 200_000.5 },
        },
        textBody: {
          content: [{ type: "paragraph", content: [] }],
          margins: {
            left: 91_440.5,
            top: 45_720.3,
            right: 91_440.5,
            bottom: 45_720.3,
          },
        },
      },
    },
  ],
};

const ANY_DECIMAL_IN_EMU_ATTR =
  /(?:cx|cy|distT|distB|distL|distR|lIns|tIns|rIns|bIns)="-?\d+\.\d+"/u;
const POSOFFSET_DECIMAL = /<wp:posOffset>-?\d+\.\d+<\/wp:posOffset>/u;

describe("image EMU attributes are integer-only (issue #417)", () => {
  test("inline image with float dimensions serializes integer cx/cy/effectExtent", () => {
    const xml = serializeRun(FLOAT_INLINE_IMAGE);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_EMU_ATTR);
    expect(xml).toContain('<wp:extent cx="5610225" cy="495300"/>');
    expect(xml).toContain('<a:ext cx="5610225" cy="495300"/>');
    // Per ECMA-376 §20.4.2.5 / §20.4.2.8, image.padding (shadow/glow
    // reservation) belongs in <wp:effectExtent>; it no longer leaks into
    // wp:inline distT/B/L/R. With padding {top: 0.4, bottom: 0.6},
    // intAttr rounds → t="0" b="1" on the effectExtent element.
    expect(xml).toContain('<wp:effectExtent l="0" t="0" r="0" b="1"/>');
    expect(xml).toContain('distT="0" distB="0" distL="0" distR="0"');
  });

  test("floating image with float position/extent serializes integer attrs", () => {
    const xml = serializeRun(FLOAT_FLOATING_IMAGE);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_EMU_ATTR);
    expect(xml).not.toMatch(POSOFFSET_DECIMAL);
    expect(xml).toContain('<wp:extent cx="1905000" cy="933450"/>');
    expect(xml).toContain("<wp:posOffset>238125</wp:posOffset>");
    expect(xml).toContain("<wp:posOffset>962025</wp:posOffset>");
    expect(xml).toContain('distT="114300"');
  });

  test("behind-wrapped image with negative offset rounds correctly", () => {
    const xml = serializeRun(FLOAT_BEHIND_IMAGE);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_EMU_ATTR);
    expect(xml).not.toMatch(POSOFFSET_DECIMAL);
    expect(xml).toContain('behindDoc="1"');
    expect(xml).toContain('<wp:extent cx="495300" cy="495300"/>');
    expect(xml).toContain("<wp:posOffset>-51</wp:posOffset>");
  });
});

describe("shape EMU attributes are integer-only (issue #417)", () => {
  test("inline shape with float size serializes integer cx/cy", () => {
    const xml = serializeRun(FLOAT_INLINE_SHAPE);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_EMU_ATTR);
    expect(xml).toContain('<a:ext cx="1234568" cy="987654"/>');
    expect(xml).toContain('<wp:extent cx="1234568" cy="987654"/>');
  });

  test("floating textbox with float dimensions/position/margins is fully integer", () => {
    const xml = serializeRun(FLOAT_FLOATING_TEXTBOX);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_EMU_ATTR);
    expect(xml).not.toMatch(POSOFFSET_DECIMAL);
    expect(xml).toContain('<wp:extent cx="2540000" cy="1270001"/>');
    expect(xml).toContain('<a:ext cx="2540000" cy="1270001"/>');
    expect(xml).toContain('distT="91441" distB="91440"');
    expect(xml).toContain("<wp:posOffset>100001</wp:posOffset>");
    expect(xml).toContain("<wp:posOffset>200001</wp:posOffset>");
    expect(xml).toContain('lIns="91441"');
    expect(xml).toContain('tIns="45720"');
    expect(xml).toContain('rIns="91441"');
    expect(xml).toContain('bIns="45720"');
    expect(xml.match(/<wps:wsp>/gu)).toHaveLength(1);
    expect(xml).toContain('<wps:cNvSpPr txBox="1"/>');
    expect(xml).toContain("<wps:txbx><w:txbxContent>");
  });
});

describe("run formatting integer attributes (issue #417)", () => {
  test("font size, character spacing, scale, kern, position render as integers", () => {
    const run: Run = {
      type: "run",
      content: [{ type: "text", text: "x" }],
      formatting: {
        fontSize: 22.000_000_1,
        fontSizeCs: 21.999_999,
        spacing: 19.999_999_998,
        scale: 99.999_99,
        kerning: 18.000_000_3,
        position: -6.000_000_1,
      },
    };

    const xml = serializeRun(run);

    expect(xml).not.toMatch(/w:val="-?\d+\.\d+"/u);
    expect(xml).toContain('<w:sz w:val="22"/>');
    expect(xml).toContain('<w:szCs w:val="22"/>');
    expect(xml).toContain('<w:spacing w:val="20"/>');
    expect(xml).toContain('<w:w w:val="100"/>');
    expect(xml).toContain('<w:kern w:val="18"/>');
    expect(xml).toContain('<w:position w:val="-6"/>');
  });
});
