import { describe, expect, test } from "bun:test";

import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";

describe("htmlToMarkdown", () => {
  test("returns empty string for empty or whitespace input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
    expect(htmlToMarkdown("\n\n")).toBe("");
  });

  test("plain paragraph ends with a single trailing newline", () => {
    expect(htmlToMarkdown("<p>Hello world</p>")).toBe("Hello world\n");
  });

  test("multiple paragraphs are separated by a blank line", () => {
    expect(htmlToMarkdown("<p>First</p><p>Second</p>")).toBe(
      "First\n\nSecond\n",
    );
  });

  test("inline emphasis maps to markdown markers", () => {
    expect(htmlToMarkdown("<p><strong>bold</strong></p>")).toBe("**bold**\n");
    expect(htmlToMarkdown("<p><b>bold</b></p>")).toBe("**bold**\n");
    expect(htmlToMarkdown("<p><em>it</em></p>")).toBe("*it*\n");
    expect(htmlToMarkdown("<p><i>it</i></p>")).toBe("*it*\n");
    expect(htmlToMarkdown("<p><del>x</del></p>")).toBe("~~x~~\n");
    expect(htmlToMarkdown("<p><s>x</s></p>")).toBe("~~x~~\n");
  });

  test("inline code preserves raw content (no escaping inside backticks)", () => {
    expect(htmlToMarkdown("<p><code>const x = 1</code></p>")).toBe(
      "`const x = 1`\n",
    );
    expect(htmlToMarkdown("<p><code>*not bold*</code></p>")).toBe(
      "`*not bold*`\n",
    );
  });

  test("anchors render as markdown links with href preserved verbatim", () => {
    expect(
      htmlToMarkdown('<p><a href="https://example.com">Example</a></p>'),
    ).toBe("[Example](https://example.com)\n");
    expect(
      htmlToMarkdown('<p><a href="#stella-workspace=ws_1">WS</a></p>'),
    ).toBe("[WS](#stella-workspace=ws_1)\n");
    expect(htmlToMarkdown('<p><a href="">no</a></p>')).toBe("[no]()\n");
  });

  test("u/sub/sup pass through as raw HTML (no markdown equivalent)", () => {
    expect(htmlToMarkdown("<p><u>under</u></p>")).toBe("<u>under</u>\n");
    expect(htmlToMarkdown("<p>x<sub>2</sub></p>")).toBe("x<sub>2</sub>\n");
    expect(htmlToMarkdown("<p>x<sup>2</sup></p>")).toBe("x<sup>2</sup>\n");
  });

  test("br emits a markdown line break (two spaces + newline)", () => {
    expect(htmlToMarkdown("<p>line one<br>line two</p>")).toBe(
      "line one  \nline two\n",
    );
  });

  test("hr emits a thematic break", () => {
    expect(htmlToMarkdown("<p>before</p><hr><p>after</p>")).toBe(
      "before\n\n---\n\nafter\n",
    );
  });

  test("headings emit ATX markers matching the level", () => {
    expect(htmlToMarkdown("<h1>One</h1>")).toBe("# One\n");
    expect(htmlToMarkdown("<h2>Two</h2>")).toBe("## Two\n");
    expect(htmlToMarkdown("<h3>Three</h3>")).toBe("### Three\n");
    expect(htmlToMarkdown("<h6>Six</h6>")).toBe("###### Six\n");
  });

  test("unordered list items get '- ' marker per line", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b\n");
  });

  test("ordered list items number sequentially", () => {
    expect(htmlToMarkdown("<ol><li>x</li><li>y</li><li>z</li></ol>")).toBe(
      "1. x\n2. y\n3. z\n",
    );
  });

  test("blockquote prefixes each line with '> '", () => {
    expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe(
      "> quoted\n",
    );
    expect(
      htmlToMarkdown("<blockquote><p>line one</p><p>line two</p></blockquote>"),
    ).toBe("> line one\n>\n> line two\n");
  });

  test("pre>code emits fenced code block with language hint", () => {
    expect(
      htmlToMarkdown(
        '<pre><code class="language-ts">const x = 1;</code></pre>',
      ),
    ).toBe("```ts\nconst x = 1;\n```\n");
    expect(htmlToMarkdown("<pre><code>plain</code></pre>")).toBe(
      "```\nplain\n```\n",
    );
  });

  test("table renders as GFM with header row + separator", () => {
    const html =
      "<table><thead><tr><th>A</th><th>B</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
    );
  });

  test("table cell pipes are escaped, embedded newlines flattened", () => {
    const html = "<table><tr><th>x</th></tr><tr><td>a|b<br>c</td></tr></table>";
    expect(htmlToMarkdown(html)).toBe("| x |\n| --- |\n| a\\|b   c |\n");
  });

  test("markdown special characters in text are backslash-escaped", () => {
    expect(htmlToMarkdown("<p>5 * 3</p>")).toBe("5 \\* 3\n");
    expect(htmlToMarkdown("<p>foo_bar</p>")).toBe("foo\\_bar\n");
    expect(htmlToMarkdown("<p>see [note]</p>")).toBe("see \\[note\\]\n");
    expect(htmlToMarkdown("<p>backtick: `x`</p>")).toBe("backtick: \\`x\\`\n");
    expect(htmlToMarkdown("<p>angle: &lt;tag&gt;</p>")).toBe(
      "angle: \\<tag\\>\n",
    );
  });

  test("unknown tags are unwrapped (children rendered, tag dropped)", () => {
    expect(htmlToMarkdown("<p><span>unwrapped</span></p>")).toBe("unwrapped\n");
    expect(htmlToMarkdown("<div><p>nested</p></div>")).toBe("nested\n");
  });

  test("nested inline formatting composes left-to-right", () => {
    expect(
      htmlToMarkdown("<p><strong>bold and <em>italic</em></strong></p>"),
    ).toBe("**bold and *italic***\n");
  });

  test("link text inside emphasis stays inside link brackets", () => {
    expect(htmlToMarkdown('<p><em><a href="x">link</a></em></p>')).toBe(
      "*[link](x)*\n",
    );
  });

  test("paragraph→link round-trips through Bun.markdown back to the same HTML", () => {
    const html = '<p>see <a href="https://example.com">here</a> for more</p>';
    const md = htmlToMarkdown(html);
    const reHtml = Bun.markdown.html(md);
    expect(reHtml).toContain('<a href="https://example.com">here</a>');
    expect(reHtml).toContain("see");
    expect(reHtml).toContain("for more");
  });

  test("escaped specials round-trip through Bun.markdown without becoming formatting", () => {
    const md = htmlToMarkdown("<p>5 * 3 = 15</p>");
    const reHtml = Bun.markdown.html(md);
    expect(reHtml).toContain("5 * 3 = 15");
    expect(reHtml).not.toContain("<em>");
    expect(reHtml).not.toContain("<strong>");
  });

  test("tilde is escaped so literal ~~text~~ does not become a strikethrough", () => {
    expect(htmlToMarkdown("<p>literal ~~text~~ here</p>")).toBe(
      "literal \\~\\~text\\~\\~ here\n",
    );
    const md = htmlToMarkdown("<p>~~not strike~~</p>");
    const reHtml = Bun.markdown.html(md);
    expect(reHtml).not.toContain("<del>");
    expect(reHtml).not.toContain("<s>");
  });

  test("inline code with internal backticks uses a longer fence", () => {
    expect(htmlToMarkdown("<p><code>a`b</code></p>")).toBe("``a`b``\n");
    expect(htmlToMarkdown("<p><code>a``b</code></p>")).toBe("```a``b```\n");
  });

  test("inline code starting or ending with a backtick gets padding spaces", () => {
    expect(htmlToMarkdown("<p><code>`x</code></p>")).toBe("`` `x ``\n");
    expect(htmlToMarkdown("<p><code>x`</code></p>")).toBe("`` x` ``\n");
  });

  test("br inside pre/code becomes a real newline (not silently dropped)", () => {
    expect(htmlToMarkdown("<pre><code>line1<br>line2</code></pre>")).toBe(
      "```\nline1\nline2\n```\n",
    );
  });

  test("empty blocks do not produce excess blank-line runs", () => {
    expect(htmlToMarkdown("<p>before</p><p></p><p>after</p>")).toBe(
      "before\n\nafter\n",
    );
    expect(htmlToMarkdown("<blockquote></blockquote>")).toBe("");
    expect(htmlToMarkdown("<p>only</p><blockquote></blockquote>")).toBe(
      "only\n",
    );
  });

  test("pre extracts text from the inner code element, ignoring whitespace between tags", () => {
    expect(
      htmlToMarkdown('<pre>\n  <code class="language-ts">x</code>\n</pre>'),
    ).toBe("```ts\nx\n```\n");
  });

  test("table caption renders as a bold line above the table", () => {
    const html =
      "<table><caption>Quarterly results</caption>" +
      "<thead><tr><th>Q</th><th>Revenue</th></tr></thead>" +
      "<tbody><tr><td>Q1</td><td>10</td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe(
      "**Quarterly results**\n\n| Q | Revenue |\n| --- | --- |\n| Q1 | 10 |\n",
    );
  });
});
