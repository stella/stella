import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { isTextOverflowing, TruncatedText } from "./truncated-text";

const box = (scroll: [number, number], client: [number, number]) => ({
  clientHeight: client[1],
  clientWidth: client[0],
  scrollHeight: scroll[1],
  scrollWidth: scroll[0],
});

describe("TruncatedText", () => {
  test("renders the full text on one truncated line, with no hint yet", () => {
    const markup = renderToStaticMarkup(
      <TruncatedText>Smlouva o dílo č. 2026/118</TruncatedText>,
    );

    expect(markup).toStartWith("<span");
    expect(markup).toContain('data-slot="truncated-text"');
    expect(markup).toContain("truncate");
    expect(markup).toContain("Smlouva o dílo č. 2026/118");
    expect(markup).not.toContain('data-slot="tooltip-popup"');
    expect(markup).not.toContain('data-slot="popover-popup"');
  });

  test("clamps to several lines", () => {
    const markup = renderToStaticMarkup(
      <TruncatedText lines={2}>A long description</TruncatedText>,
    );

    expect(markup).toContain("line-clamp-2");
    expect(markup).not.toContain(" truncate");
  });

  test("renders through another element", () => {
    const markup = renderToStaticMarkup(
      <TruncatedText render={<p />}>Matter title</TruncatedText>,
    );

    expect(markup).toStartWith("<p");
    expect(markup).toContain("Matter title");
  });

  test("counts text as cut only when it overflows its box", () => {
    expect(isTextOverflowing(null)).toBe(false);
    expect(isTextOverflowing(box([120, 20], [120, 20]))).toBe(false);
    expect(isTextOverflowing(box([240, 20], [120, 20]))).toBe(true);
    expect(isTextOverflowing(box([120, 60], [120, 40]))).toBe(true);
  });
});
