import { describe, expect, test } from "bun:test";

import {
  blockDirectiveLinePattern,
  classifyMarker,
  classifyMarkerDefect,
  DIRECTIVE_KINDS,
  isBlockDirectiveKind,
  isFieldPath,
  isSafeFieldPath,
  legacyLoopAlias,
  legacyMarkerReplacement,
  replaceOutputMarkers,
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
  test("classifies every output form", () => {
    expect(classifyMarker("tenant.name")).toEqual({
      kind: "placeholder",
      expr: "tenant.name",
      filters: [],
    });
    expect(classifyMarker(' clause("Indemnity") ')).toEqual({
      kind: "clause",
      name: "Indemnity",
      version: undefined,
    });
    expect(classifyMarker('clause("Indemnity", "v3")')).toEqual({
      kind: "clause",
      name: "Indemnity",
      version: "v3",
    });
    expect(classifyMarker('num("scope")')).toEqual({
      kind: "num",
      key: "scope",
    });
    expect(classifyMarker('ref("scope")')).toEqual({
      kind: "ref",
      key: "scope",
    });
    expect(classifyMarker("loop.index")).toEqual({
      kind: "loop",
      property: "index",
    });
    expect(classifyMarker(" loop.length ")).toEqual({
      kind: "loop",
      property: "length",
    });
  });

  test("classifies every tag form", () => {
    expect(classifyMarker("if individual", "statement")).toEqual({
      kind: "if",
      expr: "individual",
    });
    expect(classifyMarker("elif company", "statement")).toEqual({
      kind: "elif",
      expr: "company",
    });
    expect(classifyMarker("else", "statement")).toEqual({ kind: "else" });
    expect(classifyMarker("endif", "statement")).toEqual({ kind: "endif" });
    expect(classifyMarker("for item in items", "statement")).toEqual({
      kind: "for",
      alias: "item",
      path: "items",
    });
    expect(classifyMarker("endfor", "statement")).toEqual({ kind: "endfor" });
  });

  test("a tag word is not an output marker and a path is not a tag", () => {
    expect(classifyMarker("if individual")).toBeNull();
    expect(classifyMarker("tenant.name", "statement")).toBeNull();
  });

  test("parses a filter chain onto the placeholder", () => {
    expect(
      classifyMarker('deposit | number | label("Kaution") | required'),
    ).toEqual({
      kind: "placeholder",
      expr: "deposit",
      filters: [
        { name: "number", args: [] },
        {
          name: "label",
          args: [{ kind: "positional", value: "Kaution" }],
        },
        { name: "required", args: [] },
      ],
    });
  });

  test("filter arguments carry literals and keywords", () => {
    expect(
      classifyMarker(
        'summary | ai("Draft it", adapt=true, sees_document=false)',
      ),
    ).toEqual({
      kind: "placeholder",
      expr: "summary",
      filters: [
        {
          name: "ai",
          args: [
            { kind: "positional", value: "Draft it" },
            { kind: "keyword", name: "adapt", value: true },
            { kind: "keyword", name: "sees_document", value: false },
          ],
        },
      ],
    });
    expect(classifyMarker("term | number | min(1) | max(60)")).toEqual({
      kind: "placeholder",
      expr: "term",
      filters: [
        { name: "number", args: [] },
        { name: "min", args: [{ kind: "positional", value: 1 }] },
        { name: "max", args: [{ kind: "positional", value: 60 }] },
      ],
    });
  });

  test("normalizes Word's typographic quotes and fixed spaces", () => {
    expect(classifyMarker("tenant | label(“Mieter”)")).toEqual({
      kind: "placeholder",
      expr: "tenant",
      filters: [
        { name: "label", args: [{ kind: "positional", value: "Mieter" }] },
      ],
    });
    expect(classifyMarker("for item in items", "statement")).toEqual({
      kind: "for",
      alias: "item",
      path: "items",
    });
  });

  test("rejects text that is not a directive", () => {
    expect(classifyMarker("")).toBeNull();
    expect(classifyMarker("has spaces")).toBeNull();
    expect(classifyMarker("loop.total")).toBeNull();
    expect(classifyMarker("rent * 12")).toBeNull();
    expect(classifyMarker("name.upper()")).toBeNull();
    expect(classifyMarker("set x = 1", "statement")).toBeNull();
    expect(classifyMarker("for items", "statement")).toBeNull();
  });
});

describe("scanMarkers", () => {
  test("returns recognized markers in order with correct offsets", () => {
    const text =
      'Clause {{ num("scope") }}, see {{ ref("scope") }} signed {{ signing_date }}.';
    const markers = scanMarkers(text);

    expect(markers.map((m) => m.meta.kind)).toEqual([
      "num",
      "ref",
      "placeholder",
    ]);
    for (const marker of markers) {
      expect(text.slice(marker.start, marker.end)).toBe(marker.raw);
    }
  });

  test("reads the docxtpl placement prefix off a tag", () => {
    const markers = scanMarkers("{%p if a %}{% endif %}{%tr for r in rows %}");
    expect(markers.map((m) => m.prefix)).toEqual(["paragraph", "none", "row"]);
    expect(markers.map((m) => m.form)).toEqual([
      "statement",
      "statement",
      "statement",
    ]);
  });

  test("skips unrecognized brace spans", () => {
    expect(scanMarkers("{{ not a marker!! }} and {{tenant.name}}")).toEqual([
      {
        start: 25,
        end: 40,
        raw: "{{tenant.name}}",
        inner: "tenant.name",
        form: "output",
        prefix: "none",
        meta: { kind: "placeholder", expr: "tenant.name", filters: [] },
      },
    ]);
  });
});

describe("scanInvalidMarkers", () => {
  test("flags spans that look like markers but fail classification", () => {
    const text = "Hi {{my field}} and {% set x = 1 %} but {{tenant.name}}.";
    const invalid = scanInvalidMarkers(text);

    expect(invalid.map((m) => m.raw)).toEqual([
      "{{my field}}",
      "{% set x = 1 %}",
    ]);
    for (const marker of invalid) {
      expect(text.slice(marker.start, marker.end)).toBe(marker.raw);
    }
  });

  test("ignores every recognized directive", () => {
    const text =
      '{{ num("scope") }} {% if a %} {{tenant.name}} {% endif %} {{ clause("X") }}';
    expect(scanInvalidMarkers(text)).toEqual([]);
  });

  test("is the exact complement of scanMarkers", () => {
    const text = '{{good}} {{not good}} {{ ref("k") }} {% set x %}';
    expect(scanMarkers(text).length + scanInvalidMarkers(text).length).toBe(4);
  });
});

describe("replaceOutputMarkers", () => {
  test("rewrites output markers and leaves tags alone", () => {
    expect(
      replaceOutputMarkers(
        "{% if a %}{{ name }} and {{ other }}{% endif %}",
        (_raw, inner) => inner.toUpperCase(),
      ),
    ).toBe("{% if a %}NAME and OTHER{% endif %}");
  });
});

describe("blockDirectiveLinePattern", () => {
  test("captures a whole-line tag, its prefix and its expression", () => {
    const match = blockDirectiveLinePattern().exec(
      "  {%p if tenant.active %} ",
    );

    expect(match?.groups?.["prefix"]).toBe("p");
    expect(match?.groups?.["tag"]).toBe("if");
    expect(match?.groups?.["expr"]?.trim()).toBe("tenant.active");
  });

  test("rejects tokens that only start with a directive word", () => {
    expect(blockDirectiveLinePattern().test("{% iffy tenant.active %}")).toBe(
      false,
    );
  });
});

describe("isBlockDirectiveKind", () => {
  test("distinguishes block directives from inline markers", () => {
    expect(isBlockDirectiveKind("if")).toBe(true);
    expect(isBlockDirectiveKind("placeholder")).toBe(false);
  });
});

describe("legacyMarkerReplacement", () => {
  test("names the Jinja that replaces each old-dialect marker", () => {
    expect(legacyMarkerReplacement("#if individual")).toBe(
      "{% if individual %}",
    );
    expect(legacyMarkerReplacement("#elseif company")).toBe(
      "{% elif company %}",
    );
    expect(legacyMarkerReplacement("#else")).toBe("{% else %}");
    expect(legacyMarkerReplacement("/if")).toBe("{% endif %}");
    expect(legacyMarkerReplacement("#each attorneys")).toBe(
      "{% for attorney in attorneys %}",
    );
    expect(legacyMarkerReplacement("/each")).toBe("{% endfor %}");
    expect(legacyMarkerReplacement("@index")).toBe("{{ loop.index }}");
    expect(legacyMarkerReplacement("@count")).toBe("{{ loop.length }}");
    expect(legacyMarkerReplacement("@clause:Indemnity:v3")).toBe(
      '{{ clause("Indemnity", "v3") }}',
    );
    expect(legacyMarkerReplacement("@num:scope")).toBe('{{ num("scope") }}');
    expect(legacyMarkerReplacement("@ref:scope")).toBe('{{ ref("scope") }}');
    expect(legacyMarkerReplacement("tenant.name")).toBeNull();
  });

  test("translates the old condition operators with the marker", () => {
    expect(legacyMarkerReplacement("#if !signed")).toBe("{% if not signed %}");
    expect(legacyMarkerReplacement('#if parties contains "guarantor"')).toBe(
      '{% if "guarantor" in parties %}',
    );
  });
});

describe("legacyLoopAlias", () => {
  test("singularizes a plain-word segment and falls back to item", () => {
    expect(legacyLoopAlias("attorneys")).toBe("attorney");
    expect(legacyLoopAlias("policies")).toBe("policy");
    expect(legacyLoopAlias("boxes")).toBe("box");
    expect(legacyLoopAlias("contract.fields")).toBe("field");
    expect(legacyLoopAlias("data")).toBe("item");
  });
});

describe("classifyMarkerDefect", () => {
  test("names the mistake behind a span the grammar rejects", () => {
    expect(classifyMarkerDefect("#each items")).toEqual({
      kind: "legacy_marker",
      construct: "#each items",
      replacement: "{% for item in items %}",
    });
    expect(classifyMarkerDefect("set x = 1", "statement")).toEqual({
      kind: "unsupported_tag",
      construct: "set",
    });
    expect(classifyMarkerDefect("attorneys[0].name")).toEqual({
      kind: "bracket_index",
      construct: "attorneys[0].name",
    });
    expect(classifyMarkerDefect("rent | upper")).toEqual({
      kind: "unknown_filter",
      construct: "upper",
    });
    expect(classifyMarkerDefect('total("x")')).toEqual({
      kind: "python_expression",
      construct: "total(...)",
    });
    expect(classifyMarkerDefect("rent * 12")).toEqual({
      kind: "python_expression",
      construct: "rent * 12",
    });
  });

  // The grammar is the authority: anything classifyMarker accepts is not a
  // defect, so a directive added there stops being reported with no list to
  // update here.
  test("every directive the grammar recognizes is not a defect", () => {
    const recognized = [
      ["client.name", "output"],
      ['clause("Indemnity")', "output"],
      ['num("scope")', "output"],
      ['ref("scope")', "output"],
      ["loop.index", "output"],
      ["if signed", "statement"],
      ["elif pending", "statement"],
      ["else", "statement"],
      ["endif", "statement"],
      ["for attorney in attorneys", "statement"],
      ["endfor", "statement"],
    ] as const;

    expect(
      new Set(
        recognized.flatMap(([inner, form]) => {
          const meta = classifyMarker(inner, form);
          return meta ? [meta.kind] : [];
        }),
      ).size,
    ).toBe(DIRECTIVE_KINDS.length);
    expect(
      recognized.map(([inner, form]) => classifyMarkerDefect(inner, form)),
    ).toEqual(recognized.map(() => null));
  });

  test("a near-miss with no specific diagnosis stays unclassified", () => {
    expect(classifyMarkerDefect("my field")).toBeNull();
  });
});
