import { expect, test } from "bun:test";

import { inspectMcpAppHtml } from "./mcp-app-html-guard";

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
