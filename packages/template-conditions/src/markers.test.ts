import { describe, expect, test } from "bun:test";

import {
  classifyMarker,
  DIRECTIVE_KINDS,
  isBlockDirectiveKind,
  type MarkerMeta,
  scanMarkers,
} from "./markers.js";

describe("classifyMarker", () => {
  test("classifies each directive form", () => {
    expect(classifyMarker("tenant.name")).toEqual({
      kind: "placeholder",
      expr: "tenant.name",
    });
    expect(classifyMarker(" @clause:Indemnity ")).toEqual({
      kind: "clause",
      name: "Indemnity",
      version: undefined,
    });
    expect(classifyMarker("@clause:Indemnity:v3")).toEqual({
      kind: "clause",
      name: "Indemnity",
      version: "v3",
    });
    expect(classifyMarker("@num:scope")).toEqual({ kind: "num", key: "scope" });
    expect(classifyMarker("@ref:scope")).toEqual({ kind: "ref", key: "scope" });
    expect(classifyMarker("#if individual")).toEqual({
      kind: "if",
      expr: "individual",
    });
    expect(classifyMarker("#elseif company")).toEqual({
      kind: "elseif",
      expr: "company",
    });
    expect(classifyMarker("#else")).toEqual({ kind: "else" });
    expect(classifyMarker("/if")).toEqual({ kind: "endif" });
    expect(classifyMarker("#each items")).toEqual({
      kind: "each",
      expr: "items",
    });
    expect(classifyMarker("/each")).toEqual({ kind: "endeach" });
  });

  test("rejects text that is not a directive", () => {
    expect(classifyMarker("")).toBeNull();
    expect(classifyMarker("@unknown:x")).toBeNull();
    expect(classifyMarker("has spaces")).toBeNull();
  });

  test("every kind classifyMarker emits is in DIRECTIVE_KINDS", () => {
    // Guards the union and the const list against drifting apart.
    const samples = [
      "x",
      "@clause:A",
      "@num:a",
      "@ref:a",
      "#if a",
      "#elseif a",
      "#else",
      "/if",
      "#each a",
      "/each",
    ];
    for (const sample of samples) {
      const meta = classifyMarker(sample);
      expect(meta).not.toBeNull();
      // SAFETY: asserted non-null above.
      expect(DIRECTIVE_KINDS).toContain((meta as MarkerMeta).kind);
    }
  });
});

describe("scanMarkers", () => {
  test("returns recognized markers in order with correct offsets", () => {
    const text =
      "Clause {{@num:scope}}, see {{@ref:scope}} signed {{signing_date}}.";
    const markers = scanMarkers(text);

    expect(markers.map((m) => m.meta.kind)).toEqual([
      "num",
      "ref",
      "placeholder",
    ]);
    // Offsets round-trip back to the exact source span.
    for (const marker of markers) {
      expect(text.slice(marker.start, marker.end)).toBe(marker.raw);
    }
  });

  test("skips unrecognized brace spans", () => {
    expect(scanMarkers("{{ not a marker!! }} and {{tenant.name}}")).toEqual([
      {
        start: 25,
        end: 40,
        raw: "{{tenant.name}}",
        inner: "tenant.name",
        meta: { kind: "placeholder", expr: "tenant.name" },
      },
    ]);
  });
});

describe("isBlockDirectiveKind", () => {
  test("only the block directives are block-level", () => {
    expect(isBlockDirectiveKind("if")).toBe(true);
    expect(isBlockDirectiveKind("endeach")).toBe(true);
    expect(isBlockDirectiveKind("placeholder")).toBe(false);
    expect(isBlockDirectiveKind("clause")).toBe(false);
    expect(isBlockDirectiveKind("num")).toBe(false);
  });
});
