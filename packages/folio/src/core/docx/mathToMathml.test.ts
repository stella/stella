import { describe, expect, test } from "bun:test";

import { ommlToMathml } from "./mathToMathml";
import { parseXmlDocument } from "./xmlParser";

const MATH_NS =
  'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/math"';

function parse(xml: string) {
  const root = parseXmlDocument(xml);
  if (!root) {
    throw new Error("Failed to parse OMML fixture");
  }
  return root;
}

describe("ommlToMathml — root + display", () => {
  test("returns null for a non-OMML element", () => {
    const root = parse(`<w:p xmlns:w="urn"/>`);
    expect(ommlToMathml(root)).toBeNull();
  });

  test("emits inline <math> for <m:oMath>", () => {
    const omml = parse(`<m:oMath ${MATH_NS}><m:r><m:t>x</m:t></m:r></m:oMath>`);
    const mml = ommlToMathml(omml);
    expect(mml).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML">');
    expect(mml).not.toContain('display="block"');
    expect(mml).toContain("<mi>x</mi>");
  });

  test("emits display=block for <m:oMathPara>", () => {
    const omml = parse(
      `<m:oMathPara ${MATH_NS}><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:oMathPara>`,
    );
    const mml = ommlToMathml(omml);
    expect(mml).toContain('display="block"');
    expect(mml).toContain("<mi>y</mi>");
  });

  test("returns null when conversion yields no body content", () => {
    const omml = parse(`<m:oMath ${MATH_NS}/>`);
    expect(ommlToMathml(omml)).toBeNull();
  });
});

describe("ommlToMathml — run tokenisation", () => {
  test("classifies digits into <mn>", () => {
    const omml = parse(
      `<m:oMath ${MATH_NS}><m:r><m:t>123</m:t></m:r></m:oMath>`,
    );
    expect(ommlToMathml(omml)).toContain("<mn>123</mn>");
  });

  test("classifies letters into per-character <mi>", () => {
    const omml = parse(
      `<m:oMath ${MATH_NS}><m:r><m:t>ab</m:t></m:r></m:oMath>`,
    );
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mi>a</mi>");
    expect(mml).toContain("<mi>b</mi>");
  });

  test("classifies operators into <mo>", () => {
    const omml = parse(
      `<m:oMath ${MATH_NS}><m:r><m:t>x+1</m:t></m:r></m:oMath>`,
    );
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mi>x</mi>");
    expect(mml).toContain("<mo>+</mo>");
    expect(mml).toContain("<mn>1</mn>");
  });

  test("treats decimal points as part of the digit cluster", () => {
    const omml = parse(
      `<m:oMath ${MATH_NS}><m:r><m:t>3.14</m:t></m:r></m:oMath>`,
    );
    expect(ommlToMathml(omml)).toContain("<mn>3.14</mn>");
  });

  test("escapes XML metacharacters in math text", () => {
    const omml = parse(
      `<m:oMath ${MATH_NS}><m:r><m:t>a&lt;b</m:t></m:r></m:oMath>`,
    );
    const mml = ommlToMathml(omml);
    expect(mml).toContain("&lt;");
    expect(mml).not.toContain("<b>");
  });

  test("handles Greek letters as identifiers", () => {
    const omml = parse(`<m:oMath ${MATH_NS}><m:r><m:t>α</m:t></m:r></m:oMath>`);
    expect(ommlToMathml(omml)).toContain("<mi>α</mi>");
  });
});

describe("ommlToMathml — fractions and scripts", () => {
  test("converts <m:f> into <mfrac>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:f>
          <m:num><m:r><m:t>1</m:t></m:r></m:num>
          <m:den><m:r><m:t>2</m:t></m:r></m:den>
        </m:f>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mfrac>");
    expect(mml).toContain("<mn>1</mn>");
    expect(mml).toContain("<mn>2</mn>");
  });

  test("converts <m:sSup> into <msup>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:sSup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
          <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
        </m:sSup>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<msup>");
    expect(mml).toContain("<mi>x</mi>");
    expect(mml).toContain("<mn>2</mn>");
  });

  test("converts <m:sSub> into <msub>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:sSub>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
          <m:sub><m:r><m:t>i</m:t></m:r></m:sub>
        </m:sSub>
      </m:oMath>
    `);
    expect(ommlToMathml(omml)).toContain("<msub>");
  });

  test("converts <m:sSubSup> into <msubsup>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:sSubSup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
          <m:sub><m:r><m:t>i</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
        </m:sSubSup>
      </m:oMath>
    `);
    expect(ommlToMathml(omml)).toContain("<msubsup>");
  });
});

describe("ommlToMathml — radicals", () => {
  test("converts a degree-less <m:rad> into <msqrt>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:rad>
          <m:deg/>
          <m:e><m:r><m:t>2</m:t></m:r></m:e>
        </m:rad>
      </m:oMath>
    `);
    expect(ommlToMathml(omml)).toContain("<msqrt>");
  });

  test("converts a <m:rad> with explicit degree into <mroot>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:rad>
          <m:deg><m:r><m:t>3</m:t></m:r></m:deg>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:rad>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mroot>");
    expect(mml).toContain("<mn>3</mn>");
  });
});

describe("ommlToMathml — n-ary operators", () => {
  test("converts a summation with sub+sup into <msubsup>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:nary>
          <m:naryPr><m:chr m:val="∑"/></m:naryPr>
          <m:sub><m:r><m:t>i=1</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>n</m:t></m:r></m:sup>
          <m:e><m:r><m:t>i</m:t></m:r></m:e>
        </m:nary>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mo>∑</mo>");
    expect(mml).toContain("<msubsup>");
  });

  test("converts an integral using limLoc=undOvr into <munderover>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:nary>
          <m:naryPr><m:chr m:val="∫"/><m:limLoc m:val="undOvr"/></m:naryPr>
          <m:sub><m:r><m:t>0</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>1</m:t></m:r></m:sup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:nary>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mo>∫</mo>");
    expect(mml).toContain("<munderover>");
  });
});

describe("ommlToMathml — delimiters, matrices, accents", () => {
  test("wraps <m:d> children in begChr/endChr operators", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:d>
          <m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:d>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mo>[</mo>");
    expect(mml).toContain("<mo>]</mo>");
  });

  test("converts <m:m>/<m:mr>/<m:e> into <mtable>/<mtr>/<mtd>", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:m>
          <m:mr>
            <m:e><m:r><m:t>a</m:t></m:r></m:e>
            <m:e><m:r><m:t>b</m:t></m:r></m:e>
          </m:mr>
          <m:mr>
            <m:e><m:r><m:t>c</m:t></m:r></m:e>
            <m:e><m:r><m:t>d</m:t></m:r></m:e>
          </m:mr>
        </m:m>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mtable>");
    expect((mml ?? "").match(/<mtr>/gu)?.length).toBe(2);
    expect((mml ?? "").match(/<mtd>/gu)?.length).toBe(4);
  });

  test('converts <m:acc> into <mover accent="true">', () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:acc>
          <m:accPr><m:chr m:val="̂"/></m:accPr>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:acc>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain('<mover accent="true">');
  });
});

describe("ommlToMathml — graceful degradation", () => {
  test("degrades unknown OMML elements to their children", () => {
    // `<m:unknownThing>` isn't an OMML element we model — wrap the run
    // anyway so its text survives.
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:unknownThing>
          <m:r><m:t>z</m:t></m:r>
        </m:unknownThing>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    expect(mml).toContain("<mi>z</mi>");
  });

  test("drops property-only elements without emitting output", () => {
    const omml = parse(`
      <m:oMath ${MATH_NS}>
        <m:r><m:rPr><m:nor/></m:rPr><m:t>k</m:t></m:r>
      </m:oMath>
    `);
    const mml = ommlToMathml(omml);
    // `<m:rPr>` should not bleed into MathML output.
    expect(mml).not.toContain("rPr");
    expect(mml).not.toContain("<nor");
    expect(mml).toContain("<mi>k</mi>");
  });
});
