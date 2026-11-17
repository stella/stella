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
      "max-h-[calc(var(--textarea-max-rows)*1lh+var(--textarea-pt)+var(--textarea-pb))]",
    );
    expect(markup).toContain("--textarea-max-rows:6");
  });

  // The cap adds the padding the field actually has, which depends on its
  // size, on whether it is inline, and on whether a count sits under it.
  test.each([
    {
      inline: false,
      showCount: false,
      size: "sm",
      top: "calc(--spacing(1)-1px)",
      bottom: "calc(--spacing(1)-1px)",
    },
    {
      inline: false,
      showCount: false,
      size: "default",
      top: "calc(--spacing(1.5)-1px)",
      bottom: "calc(--spacing(1.5)-1px)",
    },
    {
      inline: false,
      showCount: false,
      size: "lg",
      top: "calc(--spacing(2)-1px)",
      bottom: "calc(--spacing(2)-1px)",
    },
    {
      inline: false,
      showCount: true,
      size: "sm",
      top: "calc(--spacing(1)-1px)",
      bottom: "--spacing(6)",
    },
    {
      inline: false,
      showCount: true,
      size: "lg",
      top: "calc(--spacing(2)-1px)",
      bottom: "--spacing(6)",
    },
    {
      inline: true,
      showCount: false,
      size: "default",
      top: "0px",
      bottom: "0px",
    },
    {
      inline: true,
      showCount: true,
      size: "default",
      top: "0px",
      bottom: "--spacing(6)",
    },
  ] as const)(
    "the cap reserves the padding of $size inline=$inline count=$showCount",
    ({ inline, showCount, size, top, bottom }) => {
      const markup = renderToStaticMarkup(
        <Textarea
          aria-label="Title"
          inline={inline}
          maxLength={80}
          maxRows={1}
          showCount={showCount}
          size={size}
        />,
      );
      const field = /<textarea[^>]*>/u.exec(markup)?.[0] ?? "";
      const classes = /class="(?<classes>[^"]*)"/u
        .exec(field)
        ?.groups?.["classes"]?.split(" ");

      expect(classes).toContain("pt-(--textarea-pt)");
      expect(classes).toContain("pb-(--textarea-pb)");
      expect(classes).toContain(`[--textarea-pt:${top}]`);
      expect(classes).toContain(`[--textarea-pb:${bottom}]`);
      // One value per variable, so the cap and the padding agree.
      expect(
        classes?.filter((name) => name.startsWith("[--textarea-pb:")),
      ).toHaveLength(1);
      expect(
        classes?.filter((name) => name.startsWith("[--textarea-pt:")),
      ).toHaveLength(1);
    },
  );

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
    // The count is in the accessibility tree, not only on screen.
    expect(markup).not.toMatch(
      /<span[^>]*aria-hidden="true"[^>]*data-slot="textarea-count"/u,
    );
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

  test("an unstyled field still positions its count against itself", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Summary" maxLength={280} showCount unstyled />,
    );
    const control = /<span[^>]*data-slot="textarea-control"[^>]*>/u.exec(
      markup,
    )?.[0];

    expect(control).toMatch(/class="(?:[^"]* )?relative(?: [^"]*)?"/u);
  });

  test("no counter without a maxLength", () => {
    const markup = renderToStaticMarkup(
      <Textarea aria-label="Summary" showCount />,
    );

    expect(markup).not.toContain("textarea-count");
  });
});
