import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";
import { assertProperty } from "@stll/property-testing";

import { sanitizeVisualHtml } from "./sanitize";

describe("visual presentation markup", () => {
  test("preserves inline interactive scripts after document normalization", () => {
    const result = sanitizeVisualHtml(
      '<script>const count = 2;</script><p>Timeline</p><script>const label = "dates";</script>',
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(
        '<script>const count = 2;</script><p>Timeline</p><script>const label = "dates";</script>',
      );
    }
  });
  test("preserves text, tables, directions, disclosures and inline formatting", () => {
    const result = sanitizeVisualHtml(
      '<section dir="rtl"><h2>Timeline</h2><details open><summary>Dates</summary><table><tbody><tr><th scope="col">Date</th><td style="color:#333; padding:12px">2026</td></tr></tbody></table></details></section>',
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) {
      return;
    }
    expect(result.value).toContain('dir="rtl"');
    expect(result.value).toContain("<summary>Dates</summary>");
    expect(result.value).toContain('style="color:#333;padding:12px"');
    expect(result.value).toContain('scope="col"');
  });

  test("represents links as presentation metadata", () => {
    const result = sanitizeVisualHtml(
      '<a href="https://example.test/decision?q=a&amp;b=c">Decision</a>',
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) {
      return;
    }
    expect(result.value).toBe(
      '<a data-stella-link="https://example.test/decision?q=a&amp;b=c">Decision</a>',
    );
  });

  test("normalizes interactive presentation controls", () => {
    const result = sanitizeVisualHtml(
      '<label for="filter">Filter</label><input id="filter" type="search"><button>Sort</button>',
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(
        '<label for="filter">Filter</label><input id="filter" type="search"><button type="button">Sort</button>',
      );
    }
  });

  test("bounds UTF-8 bytes, nesting and element count", () => {
    const cases = [
      { html: "§".repeat(VISUAL_SANDBOX_LIMITS.htmlBytes), reason: "size" },
      {
        html: "& ".repeat(Math.floor(VISUAL_SANDBOX_LIMITS.htmlBytes / 2)),
        reason: "size",
      },
      {
        html: `${"<div>".repeat(
          VISUAL_SANDBOX_LIMITS.depth,
        )}text${"</div>".repeat(VISUAL_SANDBOX_LIMITS.depth)}`,
        reason: "depth",
      },
      { html: "<br>".repeat(VISUAL_SANDBOX_LIMITS.nodes + 1), reason: "nodes" },
    ];
    for (const { html, reason } of cases) {
      const result = sanitizeVisualHtml(html);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.reason).toBe(reason);
      }
    }
  });

  test("visual presentation normalization reaches a fixed point", async () => {
    await assertProperty(
      "visual presentation normalization reaches a fixed point",
      fc.property(
        fc.array(
          fc.record({
            tag: fc.constantFrom("p", "span", "strong", "details"),
            text: fc.string(),
            color: fc.constantFrom("red", "#333", "inherit"),
          }),
          { maxLength: 20 },
        ),
        (items) => {
          const html = items
            .map(
              ({ tag, text, color }) =>
                `<${tag} style="color:${color}">${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</${tag}>`,
            )
            .join("");
          const first = sanitizeVisualHtml(html);
          expect(first.isOk()).toBe(true);
          if (!first.isOk()) {
            return;
          }
          const second = sanitizeVisualHtml(first.value);
          expect(second.isOk()).toBe(true);
          if (second.isOk()) {
            expect(second.value).toBe(first.value);
          }
        },
      ),
    );
  });
});
