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
  });

  test("a fixed field keeps its rows' height and has no resize grip", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Cell value" fieldSizing="fixed" rows={2} />,
    );

    expect(textareaClass(markup)).toContain("field-sizing-fixed");
    expect(textareaClass(markup)).toContain("resize-none");
    expect(textareaClass(markup)).not.toContain("field-sizing-content");
    expect(markup).toContain('rows="2"');
  });
});
