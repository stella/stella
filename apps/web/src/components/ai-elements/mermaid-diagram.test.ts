import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Window } from "happy-dom";

import { assertProperty } from "@stll/property-testing";

import { renderDiagram } from "@/components/ai-elements/mermaid-diagram";
import { DIAGRAM_FIXTURES } from "@/components/ai-elements/mermaid-diagram.fixtures";

const FONTS = { fontFamily: "sans-serif", fontFamilyMono: "monospace" };

const FORBIDDEN_ELEMENTS = new Set([
  "a",
  "foreignobject",
  "iframe",
  "image",
  "img",
  "parsererror",
  "script",
  "style",
]);

const LINK_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

const PAINT_ATTRIBUTES = new Set([
  "clip-path",
  "fill",
  "filter",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
  "style",
]);

const unusedFallback = async () =>
  panic("fallback must not run for a type pele renders");

const renderWithPele = async (source: string) =>
  renderDiagram({ id: "d", source, fonts: FONTS, fallback: unusedFallback });

const svgViolations = (svg: string): string[] => {
  const window = new Window();
  const parsed = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  return [...parsed.querySelectorAll("*")].flatMap((element) => [
    ...(FORBIDDEN_ELEMENTS.has(element.tagName.toLowerCase())
      ? [`element ${element.tagName}`]
      : []),
    ...element.getAttributeNames().flatMap((attribute) => {
      const name = attribute.toLowerCase();
      if (name.startsWith("on") || LINK_ATTRIBUTES.has(name)) {
        return [`attribute ${name}`];
      }
      const value = element.getAttribute(attribute) ?? "";
      return PAINT_ATTRIBUTES.has(name) && /url\(\s*['"]?(?!#)/iu.test(value)
        ? [`external url in ${name}`]
        : [];
    }),
  ]);
};

const MIN_FRAGMENTS = 1;
const MAX_FRAGMENTS = 4;
const MAX_FILLER_LENGTH = 8;
const NUM_RUNS = 300;

describe("mermaid diagrams", () => {
  test.each(DIAGRAM_FIXTURES.map(({ name, source }) => [name, source]))(
    "renders %s with pele",
    async (_name, source) => {
      const { svg } = await renderWithPele(source);
      expect(svg).toStartWith("<svg");
      expect(svgViolations(svg)).toEqual([]);
    },
  );

  test("hands diagram types pele cannot detect to the fallback renderer", async () => {
    const calls: [string, string][] = [];
    const source = "zenuml\n  Alice.method()";
    const result = await renderDiagram({
      id: "fallback-id",
      source,
      fonts: FONTS,
      fallback: async (id, text) => {
        calls.push([id, text]);
        return { svg: '<svg data-renderer="fallback"></svg>' };
      },
    });
    expect(calls).toEqual([["fallback-id", source]]);
    expect(result.svg).toBe('<svg data-renderer="fallback"></svg>');
  });

  test("hostile diagram text never yields active content, links, or remote fetches", async () => {
    const hostileUrl = fc
      .tuple(
        fc.constantFrom(
          "javascript",
          " javascript",
          "java\tscript",
          "jav&#x61;script",
          "JaVaScRiPt",
          "vbscript",
          "data",
        ),
        fc.constantFrom("alert(1)", "text/html,<script>alert(1)</script>"),
      )
      .map(([scheme, body]) => `${scheme}:${body}`);
    const hostileMarkup = fc.constantFrom(
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<svg onload=alert(1)>",
      "<foreignObject><body onload=alert(1)>",
      "https://example.invalid/track.png",
      "//example.invalid/x",
      "url(https://example.invalid/x)",
      "&lt;script&gt;",
      "`**md**`",
      "[[internal]]",
      "'",
      "<",
      ">",
    );
    const text = fc
      .array(
        fc.oneof(
          hostileUrl,
          hostileMarkup,
          fc.string({ maxLength: MAX_FILLER_LENGTH }),
        ),
        { minLength: MIN_FRAGMENTS, maxLength: MAX_FRAGMENTS },
      )
      .map((parts) =>
        parts.join(" ").replaceAll('"', "'").replaceAll("\n", " "),
      );
    const template = fc.constantFrom(
      (t: string) => `flowchart TD\n  A["${t}"] --> B\n  click A href "${t}"`,
      (t: string) => `flowchart TD\n  A@{ img: "${t}", label: "${t}" } --> B`,
      (t: string) =>
        `sequenceDiagram\n  participant A as ${t}\n  A->>A: ${t}\n  link A: Doc @ ${t}`,
      (t: string) =>
        `classDiagram\n  class Matter {\n    +String ${t}\n  }\n  click Matter href "${t}"`,
      (t: string) => `stateDiagram-v2\n  [*] --> A\n  note right of A : ${t}`,
      (t: string) => `erDiagram\n  A {\n    string x "${t}"\n  }`,
      (t: string) =>
        `gantt\n  dateFormat YYYY-MM-DD\n  section S\n  ${t} :t1, 2026-01-01, 3d\n  click t1 href "${t}"`,
      (t: string) =>
        `%%{init: {"themeCSS": "${t}", "fontFamily": "${t}"}}%%\nflowchart TD\n  A --> B`,
    );
    let rendered = 0;
    await assertProperty(
      "hostile diagram text never yields active content, links, or remote fetches",
      fc.asyncProperty(template, text, async (build, value) => {
        const svg = await renderWithPele(build(value)).then(
          (result) => result.svg,
          () => null,
        );
        if (svg !== null) {
          rendered += 1;
          expect(svgViolations(svg)).toEqual([]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(rendered).toBeGreaterThan(NUM_RUNS / 2);
  });
});
