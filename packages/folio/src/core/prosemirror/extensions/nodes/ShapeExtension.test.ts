// Test fixtures intentionally contain raw hex colors as inputs to the
// validators under test; they are not rendered styles.
/* eslint-disable no-inline-style-colors/no-inline-style-colors */
import { describe, expect, test } from "bun:test";

import {
  parseGradientStops,
  sanitizeColor,
  sanitizeShapeDimension,
  sanitizeSvgId,
  sanitizeTransform,
} from "./ShapeExtension";

describe("ShapeExtension.sanitizeColor", () => {
  test("accepts six-digit hex colors", () => {
    expect(sanitizeColor("#000000")).toBe("#000000");
    expect(sanitizeColor("#FFFFFF")).toBe("#FFFFFF");
    expect(sanitizeColor("#aBcDeF")).toBe("#aBcDeF");
  });

  test("accepts the small set of well-known keywords", () => {
    expect(sanitizeColor("none")).toBe("none");
    expect(sanitizeColor("transparent")).toBe("transparent");
    expect(sanitizeColor("currentColor")).toBe("currentColor");
    expect(sanitizeColor("black")).toBe("black");
    expect(sanitizeColor("white")).toBe("white");
  });

  test("accepts the documented var(--token, #hex) form", () => {
    expect(sanitizeColor("var(--doc-shape-outline)")).toBe(
      "var(--doc-shape-outline)",
    );
    expect(sanitizeColor("var(--doc-shape-outline, #000000)")).toBe(
      "var(--doc-shape-outline, #000000)",
    );
  });

  test("rejects values that could break out of an attribute or CSS context", () => {
    for (const value of [
      "",
      "#abc",
      "#zzzzzz",
      "rgb(255,0,0)",
      "red", // legacy named colors aren't on the allowlist
      `#000"/><img src=x onerror=alert(1)>`,
      "#000;background:url(javascript:alert(1))",
      "url(javascript:alert(1))",
      "expression(alert(1))",
      "var(--evil); background:url(x)",
      "  ", // whitespace only
    ]) {
      expect(sanitizeColor(value)).toBeNull();
    }
  });

  test("rejects nullish input", () => {
    expect(sanitizeColor(null)).toBeNull();
    expect(sanitizeColor(undefined)).toBeNull();
  });
});

describe("ShapeExtension.sanitizeTransform", () => {
  test("accepts the rotate/scaleX/scaleY forms produced by the parser", () => {
    expect(sanitizeTransform("rotate(45deg)")).toBe("rotate(45deg)");
    expect(sanitizeTransform("rotate(-12.5deg)")).toBe("rotate(-12.5deg)");
    expect(sanitizeTransform("scaleX(-1)")).toBe("scaleX(-1)");
    expect(sanitizeTransform("scaleY(-1)")).toBe("scaleY(-1)");
    expect(sanitizeTransform("rotate(90deg) scaleX(-1) scaleY(-1)")).toBe(
      "rotate(90deg) scaleX(-1) scaleY(-1)",
    );
  });

  test("rejects unknown functions and CSS injection attempts", () => {
    for (const value of [
      "",
      "matrix(1,0,0,1,0,0)",
      "skew(10deg)",
      "rotate(45deg);background:url(x)",
      "rotate(45deg) ; background:red",
      "rotate(NaNdeg)",
      "rotate(45 deg)",
      "scaleX(2)", // only -1 is on the allowlist
      "rotate(45deg)/**/scaleX(-1)",
      `rotate(0deg)" onmouseover="alert(1)`,
    ]) {
      expect(sanitizeTransform(value)).toBeNull();
    }
  });
});

describe("ShapeExtension.sanitizeSvgId", () => {
  test("preserves characters that are safe inside SVG ids and CSS url fragments", () => {
    expect(sanitizeSvgId("shape_123-main")).toBe("shape_123-main");
  });

  test("strips characters that could break out of a CSS url fragment", () => {
    expect(
      sanitizeSvgId("shape);background:url(javascript:alert(1))"),
    ).toBe("shapebackgroundurljavascriptalert1");
  });

  test("rejects nullish and fully stripped values", () => {
    expect(sanitizeSvgId(null)).toBeNull();
    expect(sanitizeSvgId(undefined)).toBeNull();
    expect(sanitizeSvgId(");:()")).toBeNull();
  });
});

describe("ShapeExtension.sanitizeShapeDimension", () => {
  test("preserves valid numeric dimensions including zero", () => {
    expect(sanitizeShapeDimension(240, 100)).toBe(240);
    expect(sanitizeShapeDimension(0, 100)).toBe(0);
  });

  test("falls back for NaN and missing dimensions", () => {
    expect(sanitizeShapeDimension(Number.NaN, 100)).toBe(100);
    expect(sanitizeShapeDimension(null, 100)).toBe(100);
    expect(sanitizeShapeDimension(undefined, 80)).toBe(80);
  });
});

describe("ShapeExtension.parseGradientStops", () => {
  test("returns parsed stops when colors pass sanitization", () => {
    const raw = JSON.stringify([
      { position: 0, color: "#ff0000" },
      { position: 100_000, color: "#0000FF" },
    ]);
    expect(parseGradientStops(raw)).toEqual([
      { position: 0, color: "#ff0000" },
      { position: 100_000, color: "#0000FF" },
    ]);
  });

  test("drops stops whose color fails the allowlist", () => {
    const raw = JSON.stringify([
      { position: 0, color: "#00ff00" },
      { position: 50_000, color: `#000"/><script>` },
      { position: 100_000, color: ["java", "script:alert(1)"].join("") },
    ]);
    expect(parseGradientStops(raw)).toEqual([
      { position: 0, color: "#00ff00" },
    ]);
  });

  test("returns an empty array on malformed JSON or wrong shape", () => {
    expect(parseGradientStops(undefined)).toEqual([]);
    expect(parseGradientStops("")).toEqual([]);
    expect(parseGradientStops("not json")).toEqual([]);
    expect(parseGradientStops('{"position":0,"color":"#000000"}')).toEqual([]);
    expect(
      parseGradientStops(JSON.stringify([{ position: "0", color: "#000" }])),
    ).toEqual([]);
    expect(parseGradientStops(JSON.stringify([{ position: 0 }]))).toEqual([]);
  });
});
