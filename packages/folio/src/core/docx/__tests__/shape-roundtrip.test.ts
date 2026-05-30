import { describe, expect, test } from "bun:test";

import { serializeRun } from "../serializer/runSerializer";
import { parseShapeFromDrawing } from "../shapeParser";
import { parseXmlDocument } from "../xmlParser";

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

function shapeDrawingXml({
  prst,
  anchor,
  fill,
}: {
  prst: string;
  anchor?: boolean;
  fill?: string;
}): string {
  const container = anchor
    ? `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="column"><wp:posOffset>100000</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="paragraph"><wp:posOffset>200000</wp:posOffset></wp:positionV>
        <wp:extent cx="914400" cy="457200"/>
        <wp:wrapSquare wrapText="bothSides"/>
        <wp:docPr id="9" name="Shape 9"/>`
    : `<wp:inline>
        <wp:extent cx="914400" cy="457200"/>
        <wp:docPr id="9" name="Shape 9"/>`;
  const closeContainer = anchor ? "</wp:anchor>" : "</wp:inline>";
  return `<w:drawing ${NS}>
    ${container}
        <a:graphic>
          <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
            <wps:wsp>
              <wps:cNvPr id="9" name="Shape 9"/>
              <wps:spPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="914400" cy="457200"/>
                </a:xfrm>
                <a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>
                ${fill ?? ""}
                <a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>
              </wps:spPr>
              <wps:bodyPr/>
            </wps:wsp>
          </a:graphicData>
        </a:graphic>
    ${closeContainer}
  </w:drawing>`;
}

describe("shape parse → serialize round-trip", () => {
  test.each([
    "rect",
    "roundRect",
    "ellipse",
    "line",
    "rightArrow",
    "leftArrow",
    "upArrow",
    "downArrow",
    "leftRightArrow",
    "upDownArrow",
  ])("preserves prstGeom prst=%s", (prst) => {
    const root = parseXmlDocument(shapeDrawingXml({ prst }));
    expect(root).not.toBeNull();
    if (!root) {
      return;
    }
    const shape = parseShapeFromDrawing(root);
    expect(shape).not.toBeNull();
    if (!shape) {
      return;
    }

    const xml = serializeRun({
      type: "run",
      content: [{ type: "shape", shape }],
    });
    expect(xml).toContain(`<a:prstGeom prst="${prst}"`);
    expect(xml).toContain('cx="914400"');
    expect(xml).toContain('cy="457200"');
  });

  test("preserves solid fill colour through round-trip", () => {
    const root = parseXmlDocument(
      shapeDrawingXml({
        prst: "ellipse",
        fill: `<a:solidFill><a:srgbClr val="5B9BD5"/></a:solidFill>`,
      }),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape).not.toBeNull();
    if (!shape) {
      return;
    }
    const xml = serializeRun({
      type: "run",
      content: [{ type: "shape", shape }],
    });
    expect(xml).toContain('<a:srgbClr val="5B9BD5"');
  });

  test("preserves anchored wrap type", () => {
    const root = parseXmlDocument(
      shapeDrawingXml({ prst: "rightArrow", anchor: true }),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape).not.toBeNull();
    if (!shape) {
      return;
    }
    expect(shape.wrap?.type).toBe("square");

    const xml = serializeRun({
      type: "run",
      content: [{ type: "shape", shape }],
    });
    expect(xml).toContain("<wp:wrapSquare");
    expect(xml).toContain("<wp:anchor");
  });

  test("serializes normalized line cap values as OOXML tokens", () => {
    const root = parseXmlDocument(
      shapeDrawingXml({
        prst: "line",
        fill: `<a:noFill/><a:ln w="9525" cap="rnd"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`,
      }),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.outline?.cap).toBe("round");
    if (!shape) {
      return;
    }

    const xml = serializeRun({
      type: "run",
      content: [{ type: "shape", shape }],
    });
    expect(xml).toContain('cap="rnd"');
    expect(xml).not.toContain('cap="round"');
  });
});
