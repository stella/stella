import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { TextMark } from "../review/text-mark";
import { HighlightedTextarea } from "./highlighted-textarea";

test("renders one labelled native editor over an inaccessible matching text layer", () => {
  const markup = renderToStaticMarkup(
    <HighlightedTextarea
      aria-label="Draft"
      autoCapitalize="off"
      autoCorrect="off"
      highlightedContent={
        <TextMark variant="fill" tone="warning">
          Example
        </TextMark>
      }
      id="draft"
      onChange={() => undefined}
      spellCheck={false}
      value="Example"
    />,
  );
  expect(markup.match(/<textarea\b/gu)).toHaveLength(1);
  expect(markup).toContain('aria-label="Draft"');
  expect(markup).toContain('id="draft"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('data-slot="text-mark"');
  expect(markup).toContain(">Example</mark>");
  expect(markup).toContain('spellCheck="false"');
  expect(markup).toContain('autoCapitalize="off"');
  expect(markup).toContain('autoCorrect="off"');
  expect(markup).not.toContain('dir="');
  expect(markup.match(/leading-relaxed/gu)).toHaveLength(2);
  expect(markup.match(/whitespace-pre-wrap/gu)).toHaveLength(2);
});

test("forces one direction on the common text-layer owner", () => {
  const markup = renderToStaticMarkup(
    <HighlightedTextarea
      dir="rtl"
      highlightedContent="قانون Example"
      onChange={() => undefined}
      value="قانون Example"
    />,
  );
  expect(markup.match(/dir="rtl"/gu)).toHaveLength(2);
  expect(markup).toContain('data-slot="highlighted-textarea" dir="rtl"');
  expect(markup).not.toContain('dir="auto"');
});
