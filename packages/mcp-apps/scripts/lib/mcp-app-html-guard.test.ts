import { expect, test } from "bun:test";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { assembleMcpAppDocument } from "../../src/app-document";
import { MCP_APPS } from "../../src/manifest";
import { inspectMcpAppDocument, inspectMcpAppHtml } from "./mcp-app-html-guard";

test("the HTML guard checks elements, not React script strings", () => {
  expect(
    inspectMcpAppHtml(
      '<script>const example = "<link rel=stylesheet>";</script>',
    ),
  ).toEqual([]);
  expect(
    inspectMcpAppHtml('<script src="https://example.test/app.js"></script>'),
  ).toContain("External element: script");
});
test.each([
  '<link rel="stylesheet" href="/app.css">',
  '<img src="https://example.test/img.png">',
  '<iframe src="about:blank"></iframe>',
  '<a href="/decision">open</a>',
  '<img srcset="data:image/png;base64,AA 1x, https://example.test/image.png 2x">',
])("the HTML guard rejects external resource elements: %s", (html) => {
  expect(inspectMcpAppHtml(html).length).toBeGreaterThan(0);
});
test("inline images and script text are self-contained", () => {
  expect(
    inspectMcpAppHtml(
      '<img src="data:image/png;base64,AA"><script>const url="https://example.test";</script>',
    ),
  ).toEqual([]);
});

test("quoted inline CSS data URLs pass and remote CSS URLs fail", () => {
  expect(
    inspectMcpAppHtml(
      `<div style="background: url('data:image/png;base64,AA')"></div>`,
    ),
  ).toEqual([]);
  expect(
    inspectMcpAppHtml(
      `<div style="background: url('https://example.test/img.png')"></div>`,
    ),
  ).toContain("Non-inline style URL: div");
});

test.each([
  "@import 'https://example.test/style.css';",
  '@import url("https://example.test/style.css");',
  "body{background:url(https://example.test/image.png)}",
  'body{background:URL("/image.png")}',
  'body{background:image-set("https://example.test/image.png" 1x)}',
  'body{background:-webkit-image-set("https://example.test/image.png" 1x)}',
  'body{background:image-set(url("data:image/png;base64,AA") 1x,"/image.png" 2x)}',
  "@font-face{src:src(https://example.test/font.woff2)}",
  // References count in any context, so these fail closed.
  '/* @import "https://example.test/style.css"; */body{color:red}',
  'body::before{content:"url(https://example.test/image.png)"}',
  'body{background:image-set("data:image/png;base64,AA" 1x type("image/png"))}',
])("stylesheets require inline references: %s", (css) => {
  expect(inspectMcpAppHtml(`<style>${css}</style>`)).toContain(
    "Non-inline stylesheet URL: style",
  );
});

test.each([
  'body{background:url("data:image/png;base64,AA")}',
  "@font-face{src:url(data:font/woff2;base64,AA) format('woff2')}",
  'body{background:image-set("data:image/png;base64,AA" 1x,"data:image/png;base64,BB" 2x)}',
  "body{background:image-set(linear-gradient(red,blue) 1x)}",
  'body::before{content:"no references here"}',
])("inline stylesheets pass: %s", (css) => {
  expect(inspectMcpAppHtml(`<style>${css}</style>`)).toEqual([]);
});

test("style elements follow the CSS policy", () => {
  expect(
    inspectMcpAppHtml(
      "<style>width: expression(document.body.clientWidth)</style>",
    ),
  ).toContain("Script-bearing CSS: style");
});

test("style attributes follow the CSS policy", () => {
  expect(
    inspectMcpAppHtml('<div style="width: expression(1)"></div>'),
  ).toContain("Script-bearing CSS style: div");
});

test.each([
  ".expressionless { color: red }",
  'body::before { content: "expressionless" }',
  "color: red",
])("ordinary CSS passes the style checks: %s", (css) => {
  expect(inspectMcpAppHtml(`<style>${css}</style>`)).toEqual([]);
  expect(inspectMcpAppHtml(`<div style="${css}"></div>`)).toEqual([]);
});

test("an assembled document must parse back into its parts", () => {
  const shell = [
    "<!doctype html><html><head>",
    "</head><body>",
    "</body></html>",
  ] as const;
  expect(
    inspectMcpAppDocument(
      assembleMcpAppDocument({
        shell,
        styles: ["a{}"],
        scripts: ["var r = 1;"],
        module: 'const s = "<\\/script>";',
      }),
      {
        shell,
        styles: ["a{}"],
        scripts: ["var r = 1;"],
        module: 'const s = "<\\/script>";',
      },
    ),
  ).toEqual([]);
  const early = {
    shell,
    styles: ['a{content:"</style>"}'],
    scripts: ['const s = "</script>";'],
    module: "await 0;",
  };
  expect(inspectMcpAppDocument(assembleMcpAppDocument(early), early)).toEqual([
    "Styles do not parse back as assembled",
    "Scripts do not parse back as assembled",
  ]);
});

test("committed MCP app bundles pass the HTML guard", async () => {
  const appsDirectory = path.join(import.meta.dirname, "../../src");
  const bundlePaths = await Array.fromAsync(
    new Bun.Glob("*/generated/app.html.txt").scan({
      absolute: true,
      cwd: appsDirectory,
    }),
  );

  expect(
    bundlePaths.map((file) => repoRelativePath(appsDirectory, file)).toSorted(),
  ).toEqual(
    MCP_APPS.map(
      ({ directory }) => `${directory}/generated/app.html.txt`,
    ).toSorted(),
  );
  for (const bundlePath of bundlePaths) {
    expect(inspectMcpAppHtml(await Bun.file(bundlePath).text())).toEqual([]);
  }
});
