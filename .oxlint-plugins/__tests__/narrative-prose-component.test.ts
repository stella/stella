import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lintPage = async (source: string): Promise<number[]> =>
  lintSingleRule("require-prose", source, {
    plugin: "narrative-prose-component",
    sourcePath: "page.tsx",
  });

describe("narrative-prose-component/require-prose", () => {
  test("reports narrative paragraphs outside Prose", async () => {
    expect(
      await lintPage(
        'const page = <main>\n  <p>A long narrative explanation.</p>\n  <p className="text-sm">More narrative.</p>\n</main>;',
      ),
    ).toEqual([2, 3]);
  });

  test("accepts Prose and task-shaped paragraphs", async () => {
    expect(
      await lintPage(
        [
          "const page = <main>",
          "  <Prose>A readable narrative explanation.</Prose>",
          '  <p role="status">Saved</p>',
          '  <p className="text-xs">Metadata</p>',
          '  <p className="font-display">Label</p>',
          "  <table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>",
          "  <form><p>Field help</p></form>",
          "  <pre><p>Output</p></pre>",
          "  <RichEditor><p>Draft</p></RichEditor>",
          "</main>;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
