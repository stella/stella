import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Textarea } from "./textarea";

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
    expect(markup).toContain("5<!-- -->/<!-- -->280");
    expect(markup).toContain('maxlength="280"');
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

    expect(markup).toContain("3<!-- -->/<!-- -->10");
  });

  test("no counter without a maxLength", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Summary" showCount />,
    );

    expect(markup).not.toContain("textarea-count");
  });
});
