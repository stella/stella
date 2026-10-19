import { panic } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import { Window } from "happy-dom";
import type { DiagramPlugin } from "streamdown";

import { assertProperty } from "@stll/property-testing";

import {
  FALLBACK_MERMAID_CONFIG,
  mermaidDiagram,
  renderDiagram,
} from "@/components/ai-elements/mermaid-diagram";
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

const withDocumentFonts = async <T>(run: () => Promise<T>): Promise<T> => {
  const window = new Window();
  const restore = {
    document: Reflect.get(globalThis, "document"),
    getComputedStyle: Reflect.get(globalThis, "getComputedStyle"),
  };
  Object.defineProperty(window.document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Reflect.set(globalThis, "document", window.document);
  Reflect.set(globalThis, "getComputedStyle", () => ({
    fontFamily: "sans-serif",
    getPropertyValue: () => "monospace",
  }));
  try {
    return await run();
  } finally {
    Reflect.set(globalThis, "document", restore.document);
    Reflect.set(globalThis, "getComputedStyle", restore.getComputedStyle);
  }
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

  test("the plugin entry streamdown calls inline and in fullscreen returns the checked svg", async () => {
    // Streamdown renders the chart again for its fullscreen view through the
    // same plugin `render` and injects the returned markup as is in both
    // views, so this entry point is the one whose output must be clean.
    const source =
      'flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B\n  click A href "javascript:alert(1)"';
    const plugin = mermaidDiagram.getMermaid();
    const [inline, fullscreen] = await withDocumentFonts(async () => [
      await plugin.render("inline", source),
      await plugin.render("inline", source),
    ]);
    expect(svgViolations(inline.svg)).toEqual([]);
    expect(fullscreen.svg).toBe(inline.svg);
  });

  test("the fallback renderer runs mermaid in strict mode whatever streamdown passes", async () => {
    // The plugin ignores streamdown's `initialize`, so a config streamdown
    // hands over never reaches the fallback; the engine must still be strict
    // when it renders a diagram pele cannot detect.
    const engineConfigs: unknown[] = [];
    const engineRenders: [string, string][] = [];
    void mock.module("mermaid", () => ({
      default: {
        initialize: (config: unknown) => {
          engineConfigs.push(config);
        },
        render: async (id: string, text: string) => {
          engineRenders.push([id, text]);
          return { svg: '<svg data-renderer="mermaid"></svg>' };
        },
      },
    }));
    const source = "zenuml\n  Alice.method()";
    const asStreamdownSees: DiagramPlugin = mermaidDiagram;
    const plugin = asStreamdownSees.getMermaid({ securityLevel: "loose" });
    plugin.initialize({ securityLevel: "loose" });
    const result = await withDocumentFonts(async () =>
      plugin.render("fallback-id", source),
    );
    expect(result.svg).toBe('<svg data-renderer="mermaid"></svg>');
    expect(engineRenders).toEqual([["fallback-id", source]]);
    expect(engineConfigs.length).toBeGreaterThan(0);
    for (const config of engineConfigs) {
      expect(config).toMatchObject(FALLBACK_MERMAID_CONFIG);
    }
  });

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
