import { describe, expect, test } from "bun:test";

import {
  parseShape,
  parseShapeFromDrawing,
  shouldPreserveRawShapeDrawing,
} from "./shapeParser";
import { parseXmlDocument } from "./xmlParser";

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

function drawingWith(spPr: string, attrs?: { anchor?: boolean }): string {
  const container = attrs?.anchor
    ? `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="column"><wp:posOffset>100000</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="paragraph"><wp:posOffset>200000</wp:posOffset></wp:positionV>
        <wp:extent cx="914400" cy="457200"/>
        <wp:wrapSquare wrapText="bothSides"/>
        <wp:docPr id="7" name="Right Arrow 7"/>`
    : `<wp:inline>
        <wp:extent cx="914400" cy="457200"/>
        <wp:docPr id="7" name="Shape 7"/>`;
  const closeContainer = attrs?.anchor ? "</wp:anchor>" : "</wp:inline>";
  return `<w:drawing ${NS}>
    ${container}
        <a:graphic>
          <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
            <wps:wsp>
              <wps:cNvPr id="7" name="Shape 7"/>
              ${spPr}
              <wps:bodyPr/>
            </wps:wsp>
          </a:graphicData>
        </a:graphic>
    ${closeContainer}
  </w:drawing>`;
}

function buildSpPr({
  prst,
  fill,
  outline,
}: {
  prst: string;
  fill?: string;
  outline?: string;
}): string {
  return `<wps:spPr>
    <a:xfrm>
      <a:off x="0" y="0"/>
      <a:ext cx="914400" cy="457200"/>
    </a:xfrm>
    <a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>
    ${fill ?? ""}
    ${outline ?? ""}
  </wps:spPr>`;
}

describe("parseShapeFromDrawing — drawing dispatch", () => {
  test("returns a shape for a wps:wsp drawing without txbx", () => {
    const root = parseXmlDocument(drawingWith(buildSpPr({ prst: "rect" })));
    expect(root).not.toBeNull();
    expect(root ? parseShapeFromDrawing(root) : null).not.toBeNull();
  });

  test("returns null for a wps:wsp drawing that contains a text box", () => {
    const xml = `<w:drawing ${NS}>
      <wp:inline>
        <wp:extent cx="914400" cy="457200"/>
        <wp:docPr id="1" name="TB"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
            <wps:wsp>
              ${buildSpPr({ prst: "rect" })}
              <wps:txbx><w:txbxContent><w:p/></w:txbxContent></wps:txbx>
              <wps:bodyPr/>
            </wps:wsp>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>`;
    const root = parseXmlDocument(xml);
    expect(root ? parseShapeFromDrawing(root) : null).toBeNull();
  });

  test("returns null for picture drawings", () => {
    const xml = `<w:drawing ${NS}>
      <wp:inline>
        <wp:extent cx="100" cy="100"/>
        <wp:docPr id="1" name="img"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr><pic:cNvPr id="1" name="img"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>`;
    const root = parseXmlDocument(xml);
    expect(root ? parseShapeFromDrawing(root) : null).toBeNull();
  });
});

describe("parseShapeFromDrawing — preset geometry", () => {
  test.each([
    ["rect", "rect"],
    ["roundRect", "roundRect"],
    ["ellipse", "ellipse"],
    ["line", "line"],
    ["rightArrow", "rightArrow"],
    ["leftArrow", "leftArrow"],
    ["upArrow", "upArrow"],
    ["downArrow", "downArrow"],
  ])("captures shapeType=%s", (prst, expected) => {
    const root = parseXmlDocument(drawingWith(buildSpPr({ prst })));
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape).not.toBeNull();
    expect(shape?.shapeType).toBe(expected);
  });

  test("unknown presets are preserved as raw drawings instead of editable rectangles", () => {
    const root = parseXmlDocument(
      drawingWith(buildSpPr({ prst: "completelyUnknownShapeXYZ" })),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape).toBeNull();
    expect(root ? shouldPreserveRawShapeDrawing(root) : false).toBe(true);
  });

  test("size derived from wp:extent overrides spPr a:ext", () => {
    const root = parseXmlDocument(drawingWith(buildSpPr({ prst: "rect" })));
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.size).toEqual({ width: 914_400, height: 457_200 });
  });
});

describe("parseShapeFromDrawing — fill", () => {
  test("captures solid fill colour from a:srgbClr", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "rect",
          fill: `<a:solidFill><a:srgbClr val="5B9BD5"/></a:solidFill>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.fill).toEqual({
      type: "solid",
      color: { rgb: "5B9BD5" },
    });
  });

  test("theme-colour shapes are preserved as raw drawings until attrs carry ColorValue", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "rect",
          fill: `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>`,
        }),
      ),
    );
    expect(root ? shouldPreserveRawShapeDrawing(root) : false).toBe(true);
    expect(root ? parseShapeFromDrawing(root) : null).toBeNull();
  });

  test("recognises a:noFill as type=none", () => {
    const root = parseXmlDocument(
      drawingWith(buildSpPr({ prst: "ellipse", fill: `<a:noFill/>` })),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.fill).toEqual({ type: "none" });
  });

  test("captures gradient stops in order", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "rect",
          fill: `<a:gradFill>
            <a:gsLst>
              <a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>
              <a:gs pos="100000"><a:srgbClr val="000000"/></a:gs>
            </a:gsLst>
            <a:lin ang="5400000" scaled="1"/>
          </a:gradFill>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.fill?.type).toBe("gradient");
    expect(shape?.fill?.gradient?.type).toBe("linear");
    expect(shape?.fill?.gradient?.angle).toBe(90);
    expect(shape?.fill?.gradient?.stops).toEqual([
      { position: 0, color: { rgb: "FFFFFF" } },
      { position: 100_000, color: { rgb: "000000" } },
    ]);
  });
});

describe("parseShapeFromDrawing — outline", () => {
  test("captures outline width from a:ln", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "rect",
          outline: `<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.outline?.width).toBe(12_700);
    expect(shape?.outline?.color).toEqual({ rgb: "000000" });
  });

  test("captures prstDash style", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "line",
          outline: `<a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/></a:ln>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.outline?.style).toBe("dash");
  });

  test("captures arrow heads on line shapes", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "line",
          outline: `<a:ln w="9525">
            <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
            <a:headEnd type="none"/>
            <a:tailEnd type="triangle" w="med" len="med"/>
          </a:ln>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.outline?.tailEnd).toEqual({
      type: "triangle",
      width: "med",
      length: "med",
    });
    expect(shape?.outline?.headEnd).toEqual({ type: "none" });
  });

  test("a:ln with noFill yields no outline", () => {
    const root = parseXmlDocument(
      drawingWith(
        buildSpPr({
          prst: "rect",
          outline: `<a:ln w="9525"><a:noFill/></a:ln>`,
        }),
      ),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.outline).toBeUndefined();
  });
});

describe("parseShapeFromDrawing — anchor", () => {
  test("captures wrap type and position for anchored shapes", () => {
    const root = parseXmlDocument(
      drawingWith(buildSpPr({ prst: "rightArrow" }), { anchor: true }),
    );
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.wrap?.type).toBe("square");
    expect(shape?.position?.horizontal.relativeTo).toBe("column");
    expect(shape?.position?.vertical.relativeTo).toBe("paragraph");
  });

  test("inline shapes get wrap type 'inline'", () => {
    const root = parseXmlDocument(drawingWith(buildSpPr({ prst: "rect" })));
    const shape = root ? parseShapeFromDrawing(root) : null;
    expect(shape?.wrap?.type).toBe("inline");
  });
});

describe("parseShape — wsp element directly", () => {
  test("returns rect with size when called on a bare wps:wsp", () => {
    const xml = `<wps:wsp ${NS}>
      <wps:cNvPr id="3" name="Shape 3"/>
      ${buildSpPr({ prst: "ellipse" })}
    </wps:wsp>`;
    const root = parseXmlDocument(xml);
    expect(root).not.toBeNull();
    if (!root) {
      return;
    }
    const shape = parseShape(root);
    expect(shape.shapeType).toBe("ellipse");
    expect(shape.size).toEqual({ width: 914_400, height: 457_200 });
    expect(shape.id).toBe("3");
    expect(shape.name).toBe("Shape 3");
  });
});
