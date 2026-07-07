import { describe, expect, test } from "bun:test";

import {
  blockDirectiveLinePattern,
  classifyMarker,
  DIRECTIVE_KINDS,
  isBlockDirectiveKind,
  isFieldPath,
  isSafeFieldPath,
  scanInvalidMarkers,
  scanMarkers,
} from "./markers.js";

describe("isSafeFieldPath", () => {
  test("keeps valid dotted marker paths that cannot mutate prototypes", () => {
    expect(isFieldPath("party.name")).toBe(true);
    expect(isSafeFieldPath("party.name")).toBe(true);
    expect(isSafeFieldPath("line-item.value_2")).toBe(true);
  });

  test("rejects prototype-polluting path segments", () => {
    const unsafePaths = [
      "__proto__.polluted",
      "client.constructor.polluted",
      "client.prototype.polluted",
    ];

    for (const path of unsafePaths) {
      expect(isFieldPath(path)).toBe(true);
      expect(isSafeFieldPath(path)).toBe(false);
    }
  });
});

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
    expect(classifyMarker("@index")).toEqual({ kind: "index" });
    expect(classifyMarker(" @count ")).toEqual({ kind: "count" });
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
    // Iteration tokens take no argument: `@index:x` / `@count:x` are not them.
    expect(classifyMarker("@index:x")).toBeNull();
    expect(classifyMarker("@count:1")).toBeNull();
  });

  test("every kind classifyMarker emits is in DIRECTIVE_KINDS", () => {
    // Guards the union and the const list against drifting apart.
    const samples = [
      "x",
      "@clause:A",
      "@num:a",
      "@ref:a",
      "@index",
      "@count",
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
      if (meta) {
        expect(DIRECTIVE_KINDS).toContain(meta.kind);
      }
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

describe("scanInvalidMarkers", () => {
  test("flags brace spans that look like markers but fail classification", () => {
    const text = "Hi {{my field}} and {{@clause:}} but {{tenant.name}}.";
    const invalid = scanInvalidMarkers(text);

    expect(invalid.map((m) => m.raw)).toEqual(["{{my field}}", "{{@clause:}}"]);
    // Offsets round-trip back to the exact source span.
    for (const marker of invalid) {
      expect(text.slice(marker.start, marker.end)).toBe(marker.raw);
    }
  });

  test("ignores every recognized directive", () => {
    const text =
      "{{@num:scope}} {{#if a}} {{tenant.name}} {{/if}} {{@clause:X}}";
    expect(scanInvalidMarkers(text)).toEqual([]);
  });

  test("trims the reported inner text", () => {
    const [only] = scanInvalidMarkers("{{ has spaces }}");
    expect(only?.raw).toBe("{{ has spaces }}");
    expect(only?.inner).toBe("has spaces");
  });

  test("is the exact complement of scanMarkers", () => {
    const text = "{{good}} {{not good}} {{@ref:k}} {{@bad:}}";
    const recognized = scanMarkers(text).length;
    const invalid = scanInvalidMarkers(text).length;
    // Every `{{...}}` span lands in exactly one of the two scans.
    expect(recognized + invalid).toBe(4);
  });
});

describe("blockDirectiveLinePattern", () => {
  test("captures a whole-line block directive tag and expression", () => {
    const match = blockDirectiveLinePattern().exec(
      "  {{ #if tenant.active }} ",
    );

    expect(match?.groups?.["tag"]).toBe("#if");
    expect(match?.groups?.["expr"]?.trim()).toBe("tenant.active");
    expect(match?.[1]).toBe("#if");
  });

  test("rejects directive prefixes that are not complete tokens", () => {
    expect(blockDirectiveLinePattern().test("{{ #ifx tenant.active }}")).toBe(
      false,
    );
  });
});

describe("isBlockDirectiveKind", () => {
  test("only the block directives are block-level", () => {
    expect(isBlockDirectiveKind("if")).toBe(true);
    expect(isBlockDirectiveKind("endeach")).toBe(true);
    expect(isBlockDirectiveKind("placeholder")).toBe(false);
    expect(isBlockDirectiveKind("clause")).toBe(false);
    expect(isBlockDirectiveKind("num")).toBe(false);
    expect(isBlockDirectiveKind("index")).toBe(false);
    expect(isBlockDirectiveKind("count")).toBe(false);
  });
});
