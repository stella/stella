import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ApplicationShell } from "./application-shell";

describe("ApplicationShell", () => {
  test("keeps navigation, content, and inspector as sibling columns", () => {
    const markup = renderToStaticMarkup(
      <ApplicationShell
        header={<header data-test="header">Header</header>}
        inspector={<aside data-test="inspector">Inspector</aside>}
        sidebar={<nav data-test="sidebar">Navigation</nav>}
      >
        <article data-test="content">Content</article>
      </ApplicationShell>,
    );

    expect(markup).toMatch(
      /<nav data-test="sidebar">Navigation<\/nav><main[^>]*data-slot="application-shell-main"[^>]*><header data-test="header">Header<\/header><article data-test="content">Content<\/article><\/main><aside data-test="inspector">Inspector<\/aside>/u,
    );
  });

  test("owns the viewport frame and a shrinking content column", () => {
    const markup = renderToStaticMarkup(
      <ApplicationShell sidebar={null}>Content</ApplicationShell>,
    );

    expect(markup).toContain('data-slot="application-shell"');
    expect(markup).toContain("flex min-h-svh w-full");
    expect(markup).toContain('data-slot="application-shell-main"');
    expect(markup).toContain(
      "bg-background relative flex w-full flex-1 flex-col overflow-hidden",
    );
    expect(markup).toContain("md:peer-data-[variant=inset]:rounded-xl");
  });
});
