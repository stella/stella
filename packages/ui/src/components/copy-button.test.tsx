import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { CopyButton } from "./copy-button";

const copy = async () => await Promise.resolve(true);

describe("CopyButton", () => {
  test("shows the copy label and keeps the confirmation hidden until a copy", () => {
    const markup = renderToStaticMarkup(
      <CopyButton copiedLabel="Copied" label="Copy" onCopy={copy} />,
    );

    expect(markup).toContain('<span aria-hidden="false" class="');
    expect(markup).toMatch(/aria-hidden="false"[^>]*>Copy</u);
    expect(markup).toMatch(/aria-hidden="true"[^>]*>Copied</u);
    expect(markup).not.toContain("data-copied");
  });

  test("names an icon-only button by its label", () => {
    const markup = renderToStaticMarkup(
      <CopyButton copiedLabel="Copied" iconOnly label="Copy" onCopy={copy} />,
    );

    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toMatch(/>Copy</u);
  });
});
