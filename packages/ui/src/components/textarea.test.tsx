import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Textarea } from "./textarea";

const textareaClass = (markup: string) =>
  /<textarea[^>]*class="([^"]*)"/u.exec(markup)?.[1] ??
  /<textarea class="([^"]*)"/u.exec(markup)?.[1] ??
  "";

describe("Textarea sizing", () => {
  test("grows with its content by default", () => {
    const markup = renderToStaticMarkup(<Textarea aria-label="Note" />);

    expect(textareaClass(markup)).toContain("field-sizing-content");
    expect(textareaClass(markup)).not.toContain("resize-none");
    expect(textareaClass(markup)).toContain("min-h-17.5");
  });

  test("a fixed field keeps its rows' height and has no resize grip", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Cell value" fieldSizing="fixed" rows={2} />,
    );

    expect(textareaClass(markup)).toContain("field-sizing-fixed");
    expect(textareaClass(markup)).toContain("resize-none");
    expect(textareaClass(markup)).not.toContain("field-sizing-content");
    expect(markup).toContain('rows="2"');
    expect(textareaClass(markup)).not.toContain("min-h-");
  });
});

test("a composer editor keeps its input contract without field chrome", () => {
  const markup = renderToStaticMarkup(
    <Textarea
      appearance="composer"
      aria-label="Search"
      dir="rtl"
      fieldSizing="fixed"
      rows={1}
      maxLength={32}
      value="قانون"
      onChange={() => undefined}
    />,
  );
  expect(markup).toContain('data-appearance="composer"');
  expect(markup).toContain('aria-label="Search"');
  expect(markup).toContain('maxLength="32"');
  expect(markup).toContain('dir="rtl"');
  expect(markup).not.toContain("border-input");
  expect(textareaClass(markup)).toContain("min-h-15");
  expect(textareaClass(markup)).not.toContain("px-[calc");
});
