import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Badge } from "./badge";

describe("Badge", () => {
  test("renders a neutral small span by default", () => {
    const markup = renderToStaticMarkup(<Badge>Draft</Badge>);

    expect(markup).toStartWith("<span");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).toContain('data-size="sm"');
    expect(markup).toContain("Draft");
    expect(markup).not.toContain("badge-dot");
  });

  test("draws a decorative dot in the tone's colour", () => {
    const markup = renderToStaticMarkup(
      <Badge dot size="xs" tone="success">
        Paid
      </Badge>,
    );

    expect(markup).toContain('data-tone="success"');
    expect(markup).toContain('data-size="xs"');
    expect(markup).toContain('data-slot="badge-dot"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("bg-success");
  });

  test("has an info tone beyond the list status tones", () => {
    const markup = renderToStaticMarkup(<Badge tone="info">New</Badge>);

    expect(markup).toContain("bg-info/12");
    expect(markup).toContain("text-info-foreground");
  });

  test("renders through another element", () => {
    const markup = renderToStaticMarkup(
      <Badge render={<a href="/matters" />} tone="warning">
        Overdue
      </Badge>,
    );

    expect(markup).toStartWith("<a");
    expect(markup).toContain('href="/matters"');
    expect(markup).toContain("Overdue");
  });
});
