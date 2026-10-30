import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Textarea } from "./textarea";

/**
 * The counter's text without React's server text separators, which some
 * react-dom releases print between adjacent text nodes and others omit.
 */
const countText = (markup: string): string | undefined =>
  /data-slot="textarea-count"[^>]*>(?<text>[^<]*(?:<!-- -->[^<]*)*)</u
    .exec(markup)
    ?.groups?.["text"]?.replaceAll("<!-- -->", "");

describe("Textarea limits", () => {
  test("maxRows caps the height at that many lines", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Note" maxRows={6} />,
    );

    expect(markup).toContain(
      "max-h-[calc(var(--textarea-max-rows)*1lh+--spacing(3))]",
    );
    expect(markup).toContain("--textarea-max-rows:6");
  });

  test("a small maxRows is not overruled by the floor height", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Title" maxRows={1} size="lg" />,
    );

    expect(markup).toContain("min-h-0");
    expect(markup).not.toContain("min-h-17.5");
    expect(markup).not.toContain("min-h-18.5");
    expect(markup).not.toContain("max-sm:min-h-21.5");
  });

  test("without maxRows it grows freely", () => {
    const markup = renderToStaticMarkup(<Textarea aria-label="Note" />);

    expect(markup).not.toContain("--textarea-max-rows");
  });

  test("showCount counts toward maxLength", () => {
    const markup = renderToStaticMarkup(
      <Textarea
        aria-label="Summary"
        defaultValue="Draft"
        maxLength={280}
        showCount
      />,
    );

    expect(markup).toContain('data-slot="textarea-count"');
    expect(countText(markup)).toBe("5/280");
    // HTML attribute names are case-insensitive, and react-dom releases
    // differ in the case they print.
    expect(markup).toMatch(/ maxlength="280"/iu);
  });

  test("a controlled value is counted as given", () => {
    const markup = renderToStaticMarkup(
      <Textarea
        aria-label="Summary"
        maxLength={10}
        onChange={() => undefined}
        showCount
        value="abc"
      />,
    );

    expect(countText(markup)).toBe("3/10");
  });

  test("no counter without a maxLength", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Summary" showCount />,
    );

    expect(markup).not.toContain("textarea-count");
  });
});
