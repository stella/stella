import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Window } from "happy-dom";
import path from "node:path";
import * as pele from "pele/lazy";

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

const renderWithPele = async (source: string) =>
  renderDiagram({ id: "d", source, fonts: FONTS });

const FLOWCHART = "flowchart TD\n  A --> B";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

// Specifiers of the mermaid engine and of every package that bundles it.
const MERMAID_SPECIFIER = /^(?:mermaid|@streamdown\/mermaid)(?:\/.*)?$/u;

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bmock\.module\(\s*|\brequire\(\s*)["']([^"']+)["']/gu;

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
      const result = await renderWithPele(source);
      if (Result.isError(result)) {
        throw result.error;
      }
      expect(result.value.svg).toStartWith("<svg");
      expect(svgViolations(result.value.svg)).toEqual([]);
    },
  );

  test("a pele render that throws becomes a typed failure carrying pele's code", async () => {
    const result = await renderDiagram({
      id: "d",
      source: FLOWCHART,
      fonts: FONTS,
      loadEngine: async () => ({
        ...pele,
        render: () => {
          throw new pele.PeleError("too many nodes", "limit");
        },
      }),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("DiagramRenderFailure");
      expect(result.error.reason).toBe("limit");
    }
  });

  test("a non-pele throw from the render is still a typed failure", async () => {
    const result = await renderDiagram({
      id: "d",
      source: FLOWCHART,
      fonts: FONTS,
      loadEngine: async () => ({
        ...pele,
        render: () => {
          throw new TypeError("unexpected engine state");
        },
      }),
    });
    expect(Result.isError(result) && result.error.reason).toBe("syntax");
  });

  test("an engine chunk that fails to load is a typed failure, not a rejection", async () => {
    const result = await renderDiagram({
      id: "d",
      source: FLOWCHART,
      fonts: FONTS,
      loadEngine: async () => {
        throw new TypeError("Failed to fetch dynamically imported module");
      },
    });
    expect(Result.isError(result) && result.error.reason).toBe(
      "engine-unavailable",
    );
  });

  test("diagram types pele cannot render are typed failures, never handed to another engine", async () => {
    const result = await renderWithPele("zenuml\n  Alice.method()");
    expect(Result.isError(result) && result.error.reason).toBe(
      "unsupported-diagram",
    );
  });

  test("malformed diagram text is a typed failure", async () => {
    const result = await renderWithPele("flowchart TD\n  A --> [[[");
    expect(Result.isError(result)).toBe(true);
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
        const result = await renderWithPele(build(value));
        if (Result.isOk(result)) {
          rendered += 1;
          expect(svgViolations(result.value.svg)).toEqual([]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(rendered).toBeGreaterThan(NUM_RUNS / 2);
  });
});

describe("mermaid engine census", () => {
  test("no mermaid engine package is installed", async () => {
    const lockfile = await Bun.file(path.join(REPO_ROOT, "bun.lock")).text();
    const packages = [...lockfile.matchAll(/^ {4}"([^"]+)": \["([^"]+)@/gmu)]
      .map(([, key = "", resolved = ""]) => [key, resolved])
      .filter(([key = "", resolved = ""]) =>
        [key.split("/").at(-1), resolved].some((name) =>
          MERMAID_SPECIFIER.test(name ?? ""),
        ),
      );
    expect(packages).toEqual([]);
  });

  test("no tracked source file imports a mermaid engine", () => {
    // `git grep` narrows to lines that load a module by that name; the
    // specifier check then keeps only exact mermaid engine specifiers.
    const grep = Bun.spawnSync(
      [
        "git",
        "grep",
        "-n",
        "-E",
        String.raw`(from|import|import\(|mock\.module\(|require\()[[:space:]]*["'](@streamdown/)?mermaid`,
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.mjs",
        "*.cjs",
      ],
      { cwd: REPO_ROOT },
    );
    expect([0, 1]).toContain(grep.exitCode);
    const offenders = grep.stdout
      .toString()
      .split("\n")
      .filter((line) =>
        [...line.matchAll(IMPORT_SPECIFIER)].some(([, specifier = ""]) =>
          MERMAID_SPECIFIER.test(specifier),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
