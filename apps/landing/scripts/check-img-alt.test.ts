import { describe, expect, test } from "bun:test";

import { hasExplicitAlt, imageTags, maskComments } from "./check-img-alt";

describe("image alt attribute detection", () => {
  test("accepts alt attributes with HTML whitespace", () => {
    expect(hasExplicitAlt('<img alt="">')).toBe(true);
    expect(hasExplicitAlt("<img\nalt = {description}>")).toBe(true);
  });

  test("rejects prefixed alt-like attributes", () => {
    expect(hasExplicitAlt('<img data-alt="description">')).toBe(false);
    expect(hasExplicitAlt('<img aria-alt="description">')).toBe(false);
    expect(hasExplicitAlt('<img data-note=" alt=&quot;fake&quot;">')).toBe(
      false,
    );
  });

  test("reads through comparisons inside JSX expressions", () => {
    const source =
      "<img width={viewport > 640 ? 800 : 400} alt={description} />";

    expect(imageTags(source)).toEqual([{ offset: 0, tag: source }]);
    expect(hasExplicitAlt(imageTags(source)[0]?.tag ?? "")).toBe(true);
  });
});

describe("source comment masking", () => {
  test("preserves positions while hiding image tags in comments", () => {
    const source = [
      "<!-- <img> -->",
      "/* <img> */",
      "  // <img>",
      '<img alt="">',
    ].join("\n");
    const masked = maskComments(source);

    expect(masked).toHaveLength(source.length);
    expect([...masked.matchAll(/<img/gu)]).toHaveLength(1);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
  });
});
