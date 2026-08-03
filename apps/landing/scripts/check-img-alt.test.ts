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
    const source = ["<!-- <img> -->", "{/* <img> */}", '<img alt="">'].join(
      "\n",
    );
    const masked = maskComments(source, "astro");

    expect(masked).toHaveLength(source.length);
    expect([...masked.matchAll(/<img/gu)]).toHaveLength(1);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("does not treat comment markers in source strings as comments", () => {
    const dollar = "$";
    const interpolation = `${dollar}{condition ? "x" : "y"}`;
    const astro = [
      "---",
      'const block = "/*";',
      'const html = "<!--";',
      "---",
      '<div data-comment="<!--" data-astro="{/*" />',
      '<img src="missing-alt.png" />',
    ].join("\n");
    const tsx = [
      'const block = "/*";',
      'const line = "//";',
      `const template = \`literal /* ${interpolation} */\`;`,
      'export const Example = () => <img src="missing-alt.png" />;',
    ].join("\n");

    expect(imageTags(maskComments(astro, "astro"))).toHaveLength(1);
    expect(imageTags(maskComments(tsx, "tsx"))).toHaveLength(1);
  });

  test("masks real TSX comments outside strings and template text", () => {
    const dollar = "$";
    const interpolation = `${dollar}{condition ? /* <img> */ "x" : "y"}`;
    const source = [
      "// <img>",
      "const template = `literal /* marker */`;",
      `const value = \`${interpolation}\`;`,
      "{/* <img> */}",
      '<img alt="">',
    ].join("\n");

    expect(imageTags(maskComments(source, "tsx"))).toEqual([
      { offset: source.lastIndexOf("<img"), tag: '<img alt="">' },
    ]);
  });

  test("checks rendered Markdown but ignores metadata and code samples", () => {
    const source = [
      "---",
      'description: "example with <img>"',
      "---",
      "`<img>`",
      "```html",
      '<img src="code-sample.png">',
      "```",
      "<!-- <img> -->",
      '<img src="rendered.png">',
    ].join("\n");

    const tags = imageTags(maskComments(source, "markdown"));
    expect(tags).toEqual([
      {
        offset: source.lastIndexOf("<img"),
        tag: '<img src="rendered.png">',
      },
    ]);
    expect(hasExplicitAlt(tags[0]?.tag ?? "")).toBe(false);
  });
});
