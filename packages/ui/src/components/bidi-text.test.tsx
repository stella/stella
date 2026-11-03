import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { BidiText } from "./bidi-text";

describe("BidiText", () => {
  test.each(["bdi", "span", "div", "p"] as const)(
    "renders %s text without directional controls",
    (as) => {
      const markup = renderToStaticMarkup(
        as === "bdi" ? (
          <BidiText>{"a\u202Eb\u2066c"}</BidiText>
        ) : (
          <BidiText as={as}>{"a\u202Eb\u2066c"}</BidiText>
        ),
      );
      expect(markup).toContain(">abc<");
    },
  );

  test("keeps implicit marks, letters and element children", () => {
    expect(renderToStaticMarkup(<BidiText>{"a\u200Fשb"}</BidiText>)).toContain(
      "a\u200Fשb",
    );
    expect(
      renderToStaticMarkup(
        <BidiText>
          <b>{"c"}</b>
        </BidiText>,
      ),
    ).toContain("<b>c</b>");
  });
});
