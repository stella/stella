/**
 * Round-trip tests for OOXML image attributes that previously round-tripped
 * incorrectly. Mirrors eigenpal docx-editor PR #424 (sha c605277c9), narrowed
 * to the three sub-items the folio fork still needed:
 *   A. wp:effectExtent vs wp:inline/wp:anchor distT/B/L/R separation
 *   B. a:alphaModFix image opacity (parse + serialize)
 *   C. wp:anchor layoutInCell / allowOverlap as tri-state
 */

import { describe, expect, test } from "bun:test";

import type { Image, Run } from "../../types/document";
import { parseDrawing } from "../imageParser";
import { serializeRun } from "../serializer/runSerializer";
import { parseXml } from "../xmlParser";
import type { XmlElement } from "../xmlParser";

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(" ");

function parseDrawingFromXml(innerXml: string): Image | null {
  const doc = parseXml(`<w:drawing ${NS}>${innerXml}</w:drawing>`);
  const drawing = (doc.elements as XmlElement[])[0];
  if (!drawing) {
    return null;
  }
  return parseDrawing(drawing, undefined, undefined);
}

function serializeImage(image: Image): string {
  const run: Run = { type: "run", content: [{ type: "drawing", image }] };
  return serializeRun(run);
}

/** Parse the `<w:drawing>` payload out of a serialized `<w:r>...</w:r>` blob. */
function reparseSerializedImage(xml: string): Image | null {
  const wrapped = `<root ${NS}>${xml}</root>`;
  const doc = parseXml(wrapped);
  const root = (doc.elements as XmlElement[])[0];
  if (!root) {
    return null;
  }
  const wr = (root.elements as XmlElement[])[0]; // <w:r>
  if (!wr) {
    return null;
  }
  const drawing = (wr.elements as XmlElement[])[0]; // <w:drawing>
  if (!drawing) {
    return null;
  }
  return parseDrawing(drawing, undefined, undefined);
}

describe("wp:effectExtent stays separate from wp:inline/wp:anchor dist*", () => {
  test("inline image padding round-trips through <wp:effectExtent>, not dist*", () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 1_000_000, height: 500_000 },
      wrap: { type: "inline" },
      // image.padding is OOXML's wp:effectExtent reservation (EMUs).
      padding: { top: 100, bottom: 200, left: 300, right: 400 },
    });
    expect(xml).toContain(
      '<wp:effectExtent l="300" t="100" r="400" b="200"/>',
    );
    // No wrap distances were set, so dist* on wp:inline must be zero.
    expect(xml).toContain('distT="0" distB="0" distL="0" distR="0"');
  });

  test("inline image wrap.dist* serializes to wp:inline dist* attrs", () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "inline", distT: 1, distB: 2, distL: 3, distR: 4 },
    });
    expect(xml).toContain('distT="1" distB="2" distL="3" distR="4"');
    // No padding set → effectExtent should be all zeros.
    expect(xml).toContain('<wp:effectExtent l="0" t="0" r="0" b="0"/>');
  });

  test("floating image keeps padding and wrap.dist* on independent elements", () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "square", distT: 10, distB: 20, distL: 30, distR: 40 },
      padding: { top: 1, bottom: 2, left: 3, right: 4 },
      position: {
        horizontal: { relativeTo: "column", posOffset: 0 },
        vertical: { relativeTo: "paragraph", posOffset: 0 },
      },
    });
    expect(xml).toContain('distT="10" distB="20" distL="30" distR="40"');
    expect(xml).toContain('<wp:effectExtent l="3" t="1" r="4" b="2"/>');
  });

  test("padding survives a full XML round-trip", () => {
    const original: Image = {
      type: "image",
      rId: "rId1",
      size: { width: 1_000_000, height: 500_000 },
      wrap: { type: "inline" },
      padding: { top: 100, bottom: 200, left: 300, right: 400 },
    };
    const xml = serializeImage(original);
    const parsed = reparseSerializedImage(xml);
    expect(parsed?.padding).toEqual(original.padding);
  });
});

describe("a:alphaModFix opacity round-trip", () => {
  test("parse a:alphaModFix amt as opacity fraction", () => {
    const img = parseDrawingFromXml(`
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="1000000" cy="500000"/>
        <wp:docPr id="1" name="Picture 1"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId1"><a:alphaModFix amt="50000"/></a:blip>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>`);
    expect(img?.opacity).toBeCloseTo(0.5, 5);
  });

  test('amt="100000" (fully opaque) does not produce an opacity field', () => {
    const img = parseDrawingFromXml(`
      <wp:inline>
        <wp:extent cx="100" cy="100"/>
        <wp:docPr id="1" name="img"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="rId1"><a:alphaModFix amt="100000"/></a:blip></pic:blipFill>
            <pic:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></pic:spPr>
          </pic:pic>
        </a:graphicData></a:graphic>
      </wp:inline>`);
    expect(img?.opacity).toBeUndefined();
  });

  test("serialize opacity < 1 emits a:alphaModFix; opacity 1 omits it", () => {
    const opaque = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "inline" },
    });
    expect(opaque).not.toContain("alphaModFix");

    const transparent = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "inline" },
      opacity: 0.5,
    });
    expect(transparent).toContain('<a:alphaModFix amt="50000"/>');
  });

  test("opacity round-trips through XML", () => {
    const original: Image = {
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "inline" },
      opacity: 0.25,
    };
    const xml = serializeImage(original);
    const parsed = reparseSerializedImage(xml);
    expect(parsed?.opacity).toBeCloseTo(0.25, 5);
  });
});

describe("wp:anchor layoutInCell / allowOverlap tri-state round-trip", () => {
  test('parse explicit "0" → false', () => {
    const img = parseDrawingFromXml(`
      <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"
                 relativeHeight="0" behindDoc="0" locked="0"
                 layoutInCell="0" allowOverlap="0">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>
        <wp:extent cx="100" cy="100"/>
        <wp:wrapNone/>
        <wp:docPr id="1" name="img"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
            <pic:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></pic:spPr>
          </pic:pic>
        </a:graphicData></a:graphic>
      </wp:anchor>`);
    expect(img?.layoutInCell).toBe(false);
    expect(img?.allowOverlap).toBe(false);
  });

  test("parse absent attrs → undefined (omit the field entirely)", () => {
    const img = parseDrawingFromXml(`
      <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"
                 relativeHeight="0" behindDoc="0" locked="0">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>
        <wp:extent cx="100" cy="100"/>
        <wp:wrapNone/>
        <wp:docPr id="1" name="img"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
            <pic:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></pic:spPr>
          </pic:pic>
        </a:graphicData></a:graphic>
      </wp:anchor>`);
    expect(img?.layoutInCell).toBeUndefined();
    expect(img?.allowOverlap).toBeUndefined();
  });

  test('serializer emits explicit "0" only when the model says false', () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "square" },
      position: {
        horizontal: { relativeTo: "column", posOffset: 0 },
        vertical: { relativeTo: "paragraph", posOffset: 0 },
      },
      layoutInCell: false,
      allowOverlap: false,
    });
    expect(xml).toContain('layoutInCell="0"');
    expect(xml).toContain('allowOverlap="0"');
  });

  test('absent or explicit-true folds back to the spec default "1"', () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 100, height: 100 },
      wrap: { type: "square" },
      position: {
        horizontal: { relativeTo: "column", posOffset: 0 },
        vertical: { relativeTo: "paragraph", posOffset: 0 },
      },
    });
    expect(xml).toContain('layoutInCell="1"');
    expect(xml).toContain('allowOverlap="1"');
  });
});
