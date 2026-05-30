// eigenpal #424 (image-crop subset) — guard parse + serialize round-trip of
// wp:srcRect (`<a:srcRect l/t/r/b>`) on `<pic:blipFill>`. Folio previously
// dropped the crop attrs, so cropped images rendered uncropped after save.

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

function reparseSerializedImage(xml: string): Image | null {
  const wrapped = `<root ${NS}>${xml}</root>`;
  const doc = parseXml(wrapped);
  const root = (doc.elements as XmlElement[])[0];
  const wr = (root?.elements as XmlElement[] | undefined)?.[0];
  const drawing = (wr?.elements as XmlElement[] | undefined)?.[0];
  if (!drawing) {
    return null;
  }
  return parseDrawing(drawing, undefined, undefined);
}

describe("wp:srcRect crop parsing", () => {
  test("parses a:srcRect with all four sides into fractions", () => {
    const img = parseDrawingFromXml(`
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="1_000_000" cy="500_000"/>
        <wp:docPr id="1" name="Picture 1"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId1"/>
                <a:srcRect l="10000" t="5000" r="15000" b="20000"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1_000_000" cy="500_000"/></a:xfrm></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>`);
    expect(img?.crop).toEqual({
      left: 0.1,
      top: 0.05,
      right: 0.15,
      bottom: 0.2,
    });
  });

  test("ignores a:srcRect with all zero attrs", () => {
    const img = parseDrawingFromXml(`
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="100" cy="100"/>
        <wp:docPr id="1" name="img"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId1"/>
                <a:srcRect l="0" t="0" r="0" b="0"/>
              </pic:blipFill>
              <pic:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>`);
    expect(img?.crop).toBeUndefined();
  });

  test("parses partial a:srcRect (only some sides set)", () => {
    const img = parseDrawingFromXml(`
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="100" cy="100"/>
        <wp:docPr id="1" name="img"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="rId1"/>
                <a:srcRect l="50000" b="25000"/>
              </pic:blipFill>
              <pic:spPr><a:xfrm><a:ext cx="100" cy="100"/></a:xfrm></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>`);
    expect(img?.crop).toEqual({ left: 0.5, bottom: 0.25 });
  });
});

describe("wp:srcRect crop serialization", () => {
  test("omits a:srcRect when image has no crop", () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 1_000_000, height: 500_000 },
      wrap: { type: "inline" },
    });
    expect(xml).not.toContain("<a:srcRect");
  });

  test("emits a:srcRect with non-zero sides converted to 1/100000 units", () => {
    const xml = serializeImage({
      type: "image",
      rId: "rId1",
      size: { width: 1_000_000, height: 500_000 },
      wrap: { type: "inline" },
      crop: { left: 0.1, top: 0, right: 0.15, bottom: 0.2 },
    });
    // Zero sides are omitted; non-zero sides are scaled to 1/100000.
    expect(xml).toContain('<a:srcRect l="10000" r="15000" b="20000"/>');
    expect(xml).not.toMatch(/<a:srcRect[^>]*\bt="/u);
  });
});

describe("wp:srcRect crop round-trip", () => {
  test("parse → serialize → re-parse preserves crop fractions", () => {
    const original: Image = {
      type: "image",
      rId: "rId1",
      size: { width: 1_000_000, height: 500_000 },
      wrap: { type: "inline" },
      crop: { left: 0.1, top: 0.05, right: 0.15, bottom: 0.2 },
    };
    const xml = serializeImage(original);
    const parsed = reparseSerializedImage(xml);
    expect(parsed?.crop).toEqual(original.crop);
  });
});
