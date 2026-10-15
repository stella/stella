import { describe, expect, test } from "bun:test";

import { inspectBrowserRuntimeSafety } from "./browser-runtime-safety";

describe("browser runtime lexical bindings", () => {
  test.each([
    "fetch('/data');",
    "{ const fetch = read; } { fetch('/data'); }",
    "function read(fetch) {} fetch('/data');",
    "try {} catch (fetch) {} fetch('/data');",
    "{ const { fetch } = services; } fetch('/data');",
    "{ const [fetch] = services; } fetch('/data');",
    "for (const fetch of services) {} fetch('/data');",
    "function read() { var fetch = load; } fetch('/data');",
  ])("reports network as unavailable for a global call: %s", (source) => {
    expect(inspectBrowserRuntimeSafety(source)).toEqual({
      problems: ["network is unavailable"],
      templateWrites: 0,
    });
  });

  test.each([
    "{ const fetch = read; fetch('/data'); }",
    "function read(fetch) { fetch('/data'); }",
    "const read = (fetch) => { fetch('/data'); };",
    "try {} catch (fetch) { fetch('/data'); }",
    "{ const { fetch } = services; fetch('/data'); }",
    "{ const [fetch] = services; fetch('/data'); }",
    "for (const fetch of services) { fetch('/data'); }",
    "function read() { { var fetch = load; } fetch('/data'); }",
    "const fetch = read; function render() { fetch('/data'); }",
    "function fetch() {} fetch('/data');",
  ])("accepts calls to a visible local binding: %s", (source) => {
    expect(inspectBrowserRuntimeSafety(source)).toEqual({
      problems: [],
      templateWrites: 0,
    });
  });

  test.each([
    "{ const t = document.createElement('template'); } { t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); { const t = document.createElement('div'); t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); function parse(t) { t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); const parse = (t) => { t.innerHTML = 'x'; };",
    "const t = document.createElement('template'); try {} catch (t) { t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); { const { t } = nodes; t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); { const [t] = nodes; t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); for (const t of nodes) { t.innerHTML = 'x'; }",
  ])("requires the visible receiver to be a template: %s", (source) => {
    expect(inspectBrowserRuntimeSafety(source)).toEqual({
      problems: ["markup outside template parsing"],
      templateWrites: 1,
    });
  });

  test.each([
    "{ const t = document.createElement('template'); t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); { t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); function parse() { t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); try {} catch (error) { t.innerHTML = 'x'; }",
    "function parse() { { var t = document.createElement('template'); } t.innerHTML = 'x'; }",
    "const t = document.createElement('template'); { const t = document.createElement('div'); } t.innerHTML = 'x';",
  ])("accepts the visible template receiver: %s", (source) => {
    expect(inspectBrowserRuntimeSafety(source)).toEqual({
      problems: [],
      templateWrites: 1,
    });
  });
});
