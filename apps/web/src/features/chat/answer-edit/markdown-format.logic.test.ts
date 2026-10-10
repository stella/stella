import { expect, test } from "bun:test";
import fc from "fast-check";
import { fromMarkdown } from "mdast-util-from-markdown";

import { assertProperty } from "@stll/property-testing";

import {
  formatAnswerSpan,
  selectedMarkdownLinkUrl,
} from "./markdown-format.logic";

const GENERATED_MIN_SCALARS = 1;
const GENERATED_MAX_SCALARS = 24;
const words = fc
  .array(fc.constantFrom("a", "č", "é", "ع", "中", "😀", "𐐷"), {
    minLength: GENERATED_MIN_SCALARS,
    maxLength: GENERATED_MAX_SCALARS,
  })
  .map((characters) => characters.join(""));

test("formatting toggles preserve every outside byte and round-trip Unicode spans", () => {
  assertProperty(
    "formatting toggles preserve every outside byte and round-trip Unicode spans",
    fc.property(
      words,
      fc.constantFrom("bold", "italic"),
      fc.constantFrom("spaced", "intraword", "whitespace", "nested"),
      (text, format, layout) => {
        const body =
          layout === "intraword" ? text.replace(/[^\p{L}\p{N}]/gu, "a") : text;
        const selected = layout === "whitespace" ? ` ${body} ` : body;
        const enclosingMarker = format === "bold" ? "_" : "**";
        const outer = layout === "nested" ? enclosingMarker : "";
        const prefix =
          outer +
          (layout === "intraword" || layout === "whitespace"
            ? "before"
            : "before ");
        const suffix = `${
          (layout === "intraword" || layout === "whitespace"
            ? "after"
            : " after") + outer
        }\n\nUntouched **second** paragraph.`;
        const source = prefix + selected + suffix;
        const result = formatAnswerSpan({
          source,
          start: prefix.length,
          end: prefix.length + selected.length,
          action: { format },
        });
        expect(result.status).toBe("proposal");
        if (result.status !== "proposal") {
          return;
        }
        expect(result.selectedSource).toBe(selected);
        const formatted =
          source.slice(0, result.start) +
          result.replacement +
          source.slice(result.end);
        expect(formatted.slice(0, result.start)).toBe(prefix);
        expect(formatted.slice(result.start + result.replacement.length)).toBe(
          suffix,
        );
        const width = format === "bold" ? 2 : 1;
        const whitespace = layout === "whitespace" ? 1 : 0;
        const undone = formatAnswerSpan({
          source: formatted,
          start: result.start + width + whitespace,
          end: result.start + result.replacement.length - width - whitespace,
          action: { format },
        });
        expect(undone.status).toBe("proposal");
        if (undone.status !== "proposal") {
          return;
        }
        expect(
          formatted.slice(0, undone.start) +
            undone.replacement +
            formatted.slice(undone.end),
        ).toBe(source);
        expect(undone.edit).toEqual({
          type: "format",
          format,
          start: undone.start,
          end: undone.end,
        });
      },
    ),
  );
});

test("exact owning marks unwrap while partial or crossing marks are refused", () => {
  for (const [source, format, start, end, replacement] of [
    ["**word**", "bold", 2, 6, "word"],
    ["__word__", "bold", 2, 6, "word"],
    ["_word_", "italic", 1, 5, "word"],
    ["*word*", "italic", 1, 5, "word"],
    ["**_word_**", "bold", 3, 7, "_word_"],
  ] as const) {
    const result = formatAnswerSpan({ source, start, end, action: { format } });
    expect(result).toMatchObject({
      status: "proposal",
      start: 0,
      end: source.length,
      selectedSource: source,
      replacement,
    });
  }
  for (const [source, start, end] of [
    ["**whole word**", 2, 7],
    ["before **bold** after", 11, 18],
    ["`code`", 1, 5],
  ] as const) {
    expect(
      formatAnswerSpan({ source, start, end, action: { format: "bold" } })
        .status,
    ).toBe("unsupported");
  }
});

test("italic formatting inside a word uses valid CommonMark nesting", () => {
  const result = formatAnswerSpan({
    source: "beforewordafter",
    start: 6,
    end: 10,
    action: { format: "italic" },
  });
  expect(result).toMatchObject({ status: "proposal", replacement: "*word*" });
  expect(
    formatAnswerSpan({
      source: "a!b",
      start: 1,
      end: 2,
      action: { format: "bold" },
    }).status,
  ).toBe("unsupported");
});

test("links serialize destinations without escaping the Markdown destination", () => {
  for (const url of [
    "https://example.test/a(b)",
    "http://example.test/a\\b",
    "https://example.test/a b",
    'https://example.test/a>"(b)',
  ]) {
    const result = formatAnswerSpan({
      source: "label",
      start: 0,
      end: 5,
      action: { format: "link", url },
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") {
      continue;
    }
    const paragraph = fromMarkdown(result.replacement).children.at(0);
    const link =
      paragraph?.type === "paragraph" ? paragraph.children.at(0) : undefined;
    expect(link?.type).toBe("link");
    if (link?.type === "link") {
      expect(link.children).toMatchObject([{ type: "text", value: "label" }]);
      expect(link.url).toBe(
        result.edit.format === "link" ? result.edit.url : undefined,
      );
    }
  }
  for (const url of [
    `${"java"}script:alert(1)`,
    "data:text/plain,x",
    "/relative",
    "https://",
    "https://example.test\nnew",
  ]) {
    expect(
      formatAnswerSpan({
        source: "label",
        start: 0,
        end: 5,
        action: { format: "link", url },
      }).status,
    ).toBe("unsupported");
  }
});

test("existing links replace the whole destination while retaining nested label marks", () => {
  const source = "Before [**label**](https://old.test) after";
  const start = source.indexOf("label");
  const result = formatAnswerSpan({
    source,
    start,
    end: start + 5,
    action: { format: "link", url: "https://new.test/a(b)" },
  });
  expect(result).toMatchObject({
    status: "proposal",
    selectedSource: "[**label**](https://old.test)",
    replacement: "[**label**](<https://new.test/a(b)>)",
  });
});

test("links toggle off only the exact owning destination and round-trip label formatting", () => {
  assertProperty(
    "links toggle off only the exact owning destination and round-trip label formatting",
    fc.property(words, (text) => {
      const source = `Before ${text} after`;
      const start = "Before ".length;
      const added = formatAnswerSpan({
        source,
        start,
        end: start + text.length,
        action: { format: "link", url: "https://example.test/a(b)" },
      });
      expect(added.status).toBe("proposal");
      if (added.status !== "proposal") {
        return;
      }
      const candidate =
        source.slice(0, added.start) +
        added.replacement +
        source.slice(added.end);
      const selected = {
        source: candidate,
        start: start + 1,
        end: start + 1 + text.length,
      };
      const url = selectedMarkdownLinkUrl(selected);
      expect(url).toBe("https://example.test/a(b)");
      if (!url) {
        return;
      }
      const removed = formatAnswerSpan({
        ...selected,
        action: { format: "link", url },
      });
      expect(removed).toMatchObject({
        status: "proposal",
        selectedSource: added.replacement,
        replacement: text,
      });
      if (removed.status === "proposal") {
        expect(
          candidate.slice(0, removed.start) +
            removed.replacement +
            candidate.slice(removed.end),
        ).toBe(source);
      }
    }),
  );
  const source = "[**label**][target]\n\n[target]: https://example.test/";
  const start = source.indexOf("label");
  const url = selectedMarkdownLinkUrl({ source, start, end: start + 5 });
  expect(url).toBe("https://example.test/");
  const removed = formatAnswerSpan({
    source,
    start,
    end: start + 5,
    action: { format: "link", url: url ?? "" },
  });
  expect(removed).toMatchObject({
    status: "proposal",
    replacement: "**label**",
    selectedSource: "[**label**][target]",
  });
});

test("whole-block styles expand source markers and preserve inline marks", () => {
  const source = "Before\n\n## **Selected**\n\nAfter";
  const start = source.indexOf("Selected");
  for (const [style, replacement] of [
    ["paragraph", "**Selected**"],
    ["heading-1", "# **Selected**"],
    ["heading-6", "###### **Selected**"],
    ["unordered-list", "- **Selected**"],
    ["ordered-list", "1. **Selected**"],
  ] as const) {
    const result = formatAnswerSpan({
      source,
      start,
      end: start + 8,
      action: { format: "style", style },
    });
    expect(result).toMatchObject({
      status: "proposal",
      selectedSource: "## **Selected**",
      replacement,
    });
    if (result.status === "proposal") {
      expect(source.slice(0, result.start)).toBe("Before\n\n");
      expect(source.slice(result.end)).toBe("\n\nAfter");
    }
  }
  expect(
    formatAnswerSpan({
      source,
      start,
      end: start + 3,
      action: { format: "style", style: "heading-1" },
    }),
  ).toEqual({ status: "unsupported", reason: "whole-block-required" });
});

test("list conversions retain every item and refuse tasks, nested lists and multiline ambiguity", () => {
  const source = "- one\n- **two**";
  const result = formatAnswerSpan({
    source,
    start: 2,
    end: source.length - 2,
    action: { format: "style", style: "paragraph" },
  });
  expect(result).toMatchObject({
    status: "proposal",
    replacement: "one\n\n**two**",
    selectedSource: source,
  });
  for (const [style, replacement] of [
    ["ordered-list", "1. one\n2. **two**"],
    ["unordered-list", "- one\n- **two**"],
    ["heading-2", "## one\n\n## **two**"],
  ] as const) {
    expect(
      formatAnswerSpan({
        source,
        start: 2,
        end: source.length - 2,
        action: { format: "style", style },
      }),
    ).toMatchObject({
      status: "proposal",
      selectedSource: source,
      replacement,
    });
  }
  expect(
    formatAnswerSpan({
      source,
      start: 2,
      end: 5,
      action: { format: "style", style: "heading-1" },
    }),
  ).toEqual({ status: "unsupported", reason: "whole-block-required" });
  for (const ambiguousSource of [
    "- [x] task",
    "- outer\n  - nested",
    "first line\nsecond line",
  ]) {
    expect(
      formatAnswerSpan({
        source: ambiguousSource,
        start: 0,
        end: ambiguousSource.length,
        action: { format: "style", style: "heading-1" },
      }).status,
    ).toBe("unsupported");
  }
});
