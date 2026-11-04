import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Input } from "./input";
import { Textarea } from "./textarea";

describe("inline fields", () => {
  test("an inline input takes its parent's type and draws no control box", () => {
    const markup = renderToStaticMarkup(
      <Input aria-label="Name" defaultValue="Due diligence" inline />,
    );

    expect(markup).toContain('aria-label="Name"');
    expect(markup).toContain("text-[length:inherit]");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).not.toContain("border-input");
    expect(markup).not.toContain("min-h-8.5");
  });

  test("an inline textarea grows with its text from no floor height", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Summary" defaultValue="Reviews" inline />,
    );

    expect(markup).toContain("<textarea");
    expect(markup).toContain("field-sizing-content");
    expect(markup).not.toContain("min-h-17.5");
    expect(markup).not.toContain("border-input");
  });

  test("the default input and textarea keep their control box", () => {
    expect(renderToStaticMarkup(<Input aria-label="Name" />)).toContain(
      "border-input",
    );
    expect(renderToStaticMarkup(<Textarea aria-label="Summary" />)).toContain(
      "border-input",
    );
  });
});

describe("inline field metrics", () => {
  test("an inline input keeps the height of the text around it", () => {
    const markup = renderToStaticMarkup(
      <Input aria-label="Option name" inline size="sm" />,
    );

    expect(markup).toContain("min-h-0");
    expect(markup).toContain("leading-[inherit]");
    expect(markup).not.toContain("min-h-7.5");
  });

  test("an inline textarea keeps fixed sizing when asked", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Cell" fieldSizing="fixed" inline rows={2} />,
    );

    expect(markup).toContain("field-sizing-fixed");
    expect(markup).not.toContain("field-sizing-content");
  });
});
