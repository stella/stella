import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { CompileContext } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  CHAT_MESSAGE_EDIT_FORMAT,
  CHAT_MESSAGE_EDIT_STYLES,
  CHAT_MESSAGE_EDIT_URL_MAX_LENGTH,
  CHAT_MESSAGE_LINK_INTENT,
} from "@stll/api-contract/chat-message-revisions";
import { assertProperty } from "@stll/property-testing";

import {
  formatAnswerSpan,
  selectedMarkdownLinkUrl,
} from "./markdown-format.logic";
import type { AnswerFormatAction } from "./markdown-format.logic";

const GENERATED_MIN_SCALARS = 1;
const GENERATED_MAX_SCALARS = 24;
const GENERATED_MAX_PARAGRAPH_SCALARS = 60;
const headingStyles = CHAT_MESSAGE_EDIT_STYLES.filter((style) =>
  style.startsWith("heading-"),
);
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
      action: { format: "link", intent: "set", url },
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") {
      continue;
    }
    const paragraph = fromMarkdown(result.replacement).children.at(0);
    const link =
      paragraph?.type === "paragraph" ? paragraph.children.at(0) : undefined;
    expect(link?.type).toBe("link");
    expect(result.edit.format).toBe("link");
    if (
      link?.type === "link" &&
      result.edit.format === "link" &&
      result.edit.intent === "set"
    ) {
      expect(link.children).toMatchObject([{ type: "text", value: "label" }]);
      expect(link.url).toBe(result.edit.url);
    }
  }
  for (const url of [
    ["javascript", "alert(1)"].join(":"),
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
        action: { format: "link", intent: "set", url },
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
    action: { format: "link", intent: "set", url: "https://new.test/a(b)" },
  });
  expect(result).toMatchObject({
    status: "proposal",
    selectedSource: "[**label**](https://old.test)",
    replacement: "[**label**](<https://new.test/a(b)>)",
  });
});

test("explicit link removal round-trips label formatting", () => {
  assertProperty(
    "explicit link removal round-trips label formatting",
    fc.property(words, (text) => {
      const source = `Before ${text} after`;
      const start = "Before ".length;
      const added = formatAnswerSpan({
        source,
        start,
        end: start + text.length,
        action: {
          format: "link",
          intent: "set",
          url: "https://example.test/a(b)",
        },
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
        action: { format: "link", intent: "remove" },
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
    action: { format: "link", intent: "remove" },
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

const parsedMarkdown = (source: string) =>
  fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

const paragraphSpan = (source: string) => {
  const position = parsedMarkdown(source).children.at(0)?.position;
  if (
    position?.start.offset === undefined ||
    position.end.offset === undefined
  ) {
    return panic("Expected a positioned paragraph");
  }
  return { start: position.start.offset, end: position.end.offset };
};

const renderedText = (node: Parameters<CompileContext["enter"]>[0]): string => {
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "code" ||
    node.type === "html"
  ) {
    return node.value;
  }
  if (node.type === "break") {
    return "\n";
  }
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  return "children" in node ? node.children.map(renderedText).join("") : "";
};

test.each([
  " a",
  "Notice #",
  "Notice ##",
  "#Notice",
  "\\# Notice",
  "Notice \\#",
  "Notice \\\\#",
  "Notice `#`",
  "Notice &#35;",
])("heading conversion retains visible punctuation in %s", (source) => {
  for (const style of headingStyles) {
    const result = formatAnswerSpan({
      source,
      ...paragraphSpan(source),
      action: { format: "style", style },
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") {
      return;
    }
    const converted = parsedMarkdown(result.replacement);
    expect(converted.children.at(0)?.type).toBe("heading");
    expect(renderedText(converted)).toBe(renderedText(parsedMarkdown(source)));
  }
});

test("heading conversion preserves rendered text for arbitrary single-line paragraphs", () => {
  const paragraphs = fc
    .oneof(
      fc.string({
        unit: "grapheme",
        minLength: GENERATED_MIN_SCALARS,
        maxLength: GENERATED_MAX_PARAGRAPH_SCALARS,
      }),
      fc
        .array(
          fc.constantFrom(
            "a",
            "#",
            " ",
            "\\",
            "*",
            "_",
            "`",
            "[",
            "]",
            "(",
            ")",
            "&",
            ";",
            "<",
            ">",
            "é",
            "😀",
          ),
          {
            minLength: GENERATED_MIN_SCALARS,
            maxLength: GENERATED_MAX_PARAGRAPH_SCALARS,
          },
        )
        .map((parts) => parts.join("")),
    )
    .filter((source) => {
      const tree = parsedMarkdown(source);
      return (
        source.trim().length > 0 &&
        !/[\r\n]/u.test(source) &&
        tree.children.length === 1 &&
        tree.children.at(0)?.type === "paragraph"
      );
    });
  assertProperty(
    "heading conversion preserves rendered text for arbitrary single-line paragraphs",
    fc.property(
      paragraphs,
      fc.constantFrom(...headingStyles),
      (source, style) => {
        const result = formatAnswerSpan({
          source,
          ...paragraphSpan(source),
          action: { format: "style", style },
        });
        expect(result.status).toBe("proposal");
        if (result.status !== "proposal") {
          return;
        }
        const converted = parsedMarkdown(result.replacement);
        expect(converted.children.at(0)?.type).toBe("heading");
        expect(renderedText(converted)).toBe(
          renderedText(parsedMarkdown(source)),
        );
      },
    ),
    { numRuns: 300 },
  );
});

test.each(["# # Notice", "# - Notice", "# > Notice", "# 1. Notice"])(
  "block conversion refuses markers that would consume inline content in %s",
  (source) => {
    expect(
      formatAnswerSpan({
        source,
        start: 0,
        end: source.length,
        action: { format: "style", style: "paragraph" },
      }).status,
    ).toBe("unsupported");
  },
);

test.each([
  "https://example.test/",
  "<https://example.test/>",
  "www.example.test",
  "[https://example.test/](https://example.test/)",
  "[**https://example.test/**](https://example.test/)",
])("removing URL-shaped links refuses automatic relinking in %s", (link) => {
  const source = `Before ${link} after`;
  const original = parsedMarkdown(source);
  const paragraph = original.children.at(0);
  const linked =
    paragraph?.type === "paragraph"
      ? paragraph.children.find((node) => node.type === "link")
      : undefined;
  expect(linked?.type).toBe("link");
  if (linked?.type !== "link") {
    return;
  }
  const text = renderedText(linked);
  const start = source.indexOf(text);
  const result = formatAnswerSpan({
    source,
    start,
    end: start + text.length,
    action: { format: "link", intent: "remove" },
  });
  expect(result).toEqual({ status: "unsupported", reason: "autolink-label" });
  expect(renderedText(parsedMarkdown(source))).toBe(renderedText(original));
});

test.each([
  "[label](https://example.test/)",
  "https://example.test/",
  "<https://example.test/>",
])("setting an unchanged destination is a no-op for %s", (source) => {
  const label = source.startsWith("[label]")
    ? "label"
    : "https://example.test/";
  const start = source.indexOf(label);
  expect(
    formatAnswerSpan({
      source,
      start,
      end: start + label.length,
      action: { format: "link", intent: "set", url: "https://example.test/" },
    }),
  ).toEqual({ status: "unchanged" });
  expect(renderedText(parsedMarkdown(source))).toBe(label);
});

test.each([
  {
    source: "**# Notice**",
    format: "bold",
    markerWidth: 2,
    quoteDepth: 0,
    reason: "meaning-changed",
  },
  {
    source: "*> quote*",
    format: "italic",
    markerWidth: 1,
    quoteDepth: 0,
    reason: "meaning-changed",
  },
  {
    source: "**- item**",
    format: "bold",
    markerWidth: 2,
    quoteDepth: 0,
    reason: "meaning-changed",
  },
  {
    source: "**1. one**",
    format: "bold",
    markerWidth: 2,
    quoteDepth: 0,
    reason: "meaning-changed",
  },
  {
    source: "**<div></div>**",
    format: "bold",
    markerWidth: 2,
    quoteDepth: 0,
    reason: "ambiguous",
  },
  {
    source: "> **# Notice**",
    format: "bold",
    markerWidth: 2,
    quoteDepth: 1,
    reason: "meaning-changed",
  },
] as const)(
  "unwrapping %j refuses a change in document meaning",
  ({ source, format, markerWidth, quoteDepth, reason }) => {
    const original = parsedMarkdown(source);
    const firstBlock = original.children.at(0);
    expect(firstBlock?.type).toBe(
      quoteDepth === 0 ? "paragraph" : "blockquote",
    );
    const paragraph =
      firstBlock?.type === "blockquote"
        ? firstBlock.children.at(0)
        : firstBlock;
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph") {
      expect(paragraph.children.at(0)?.type).toBe(
        format === "bold" ? "strong" : "emphasis",
      );
    }
    const start = quoteDepth * 2 + markerWidth;
    const end = source.length - markerWidth;
    expect(renderedText(original)).toBe(source.slice(start, end));
    expect(
      formatAnswerSpan({
        source,
        start,
        end,
        action: { format },
      }),
    ).toEqual({ status: "unsupported", reason });
  },
);

type BlockTree = { type: string; children?: BlockTree[] };
const parsedBlockTree = (
  node: Parameters<CompileContext["enter"]>[0],
): BlockTree => {
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "tableCell"
  ) {
    return { type: node.type };
  }
  return "children" in node
    ? { type: node.type, children: node.children.map(parsedBlockTree) }
    : { type: node.type };
};

const markdownDescendants = (tree: Parameters<CompileContext["enter"]>[0]) => {
  const nodes: Parameters<CompileContext["enter"]>[0][] = [];
  const visit = (node: Parameters<CompileContext["enter"]>[0]) => {
    nodes.push(node);
    if ("children" in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  return nodes;
};
const linkDestinations = (tree: Parameters<CompileContext["enter"]>[0]) => {
  const nodes = markdownDescendants(tree);
  return nodes
    .flatMap((node) => {
      if (node.type === "link") {
        return [node.url];
      }
      if (node.type !== "linkReference") {
        return [];
      }
      const definition = nodes.find(
        (candidate) =>
          candidate.type === "definition" &&
          candidate.identifier === node.identifier,
      );
      if (definition?.type !== "definition") {
        return panic("Expected a resolved link reference");
      }
      return [definition.url];
    })
    .toSorted();
};

const allFormatActions = {
  bold: [{ format: CHAT_MESSAGE_EDIT_FORMAT.bold }],
  italic: [{ format: CHAT_MESSAGE_EDIT_FORMAT.italic }],
  link: [
    {
      format: CHAT_MESSAGE_EDIT_FORMAT.link,
      intent: CHAT_MESSAGE_LINK_INTENT.set,
      url: "https://updated.test/",
    },
    {
      format: CHAT_MESSAGE_EDIT_FORMAT.link,
      intent: CHAT_MESSAGE_LINK_INTENT.remove,
    },
  ],
  style: CHAT_MESSAGE_EDIT_STYLES.map((style) => ({
    format: CHAT_MESSAGE_EDIT_FORMAT.style,
    style,
  })),
} as const satisfies Record<
  (typeof CHAT_MESSAGE_EDIT_FORMAT)[keyof typeof CHAT_MESSAGE_EDIT_FORMAT],
  readonly AnswerFormatAction[]
>;

const INLINE_FORMATS = [
  CHAT_MESSAGE_EDIT_FORMAT.bold,
  CHAT_MESSAGE_EDIT_FORMAT.italic,
] as const;
const GENERATED_MAX_QUOTE_DEPTH = 2;

const formattedParagraph = ({
  body,
  format,
  quoteDepth,
}: {
  body: string;
  format: (typeof INLINE_FORMATS)[number];
  quoteDepth: number;
}) => {
  const marker = format === CHAT_MESSAGE_EDIT_FORMAT.bold ? "**" : "*";
  const source = `${"> ".repeat(quoteDepth)}${marker}${body}${marker}\n\nUntouched [reference](https://untouched.test/).`;
  const tree = parsedMarkdown(source);
  const nodes: Parameters<CompileContext["enter"]>[0][] = [];
  const walk = (node: Parameters<CompileContext["enter"]>[0]) => {
    nodes.push(node);
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(tree);
  const owner = nodes.find(
    (node) =>
      node.type === (marker === "**" ? "strong" : "emphasis") &&
      node.position?.start.offset === quoteDepth * 2,
  );
  if (owner?.type !== "strong" && owner?.type !== "emphasis") {
    return undefined;
  }
  const start = owner.children.at(0)?.position?.start.offset;
  const end = owner.children.at(-1)?.position?.end.offset;
  const paragraph = nodes.find(
    (node) =>
      node.type === "paragraph" &&
      node.position?.start.offset === quoteDepth * 2,
  );
  const paragraphStart = paragraph?.position?.start.offset;
  const paragraphEnd = paragraph?.position?.end.offset;
  if (
    start === undefined ||
    end === undefined ||
    paragraphStart === undefined ||
    paragraphEnd === undefined ||
    start === end
  ) {
    return undefined;
  }
  return {
    source,
    tree,
    quoteDepth,
    inlineSpans: nodes.flatMap((node) => {
      if (
        node.type !== "strong" &&
        node.type !== "emphasis" &&
        node.type !== "link"
      ) {
        return [];
      }
      const nestedStart = node.children.at(0)?.position?.start.offset;
      const nestedEnd = node.children.at(-1)?.position?.end.offset;
      if (
        nestedStart === undefined ||
        nestedEnd === undefined ||
        nestedStart === nestedEnd ||
        nestedEnd > paragraphEnd
      ) {
        return [];
      }
      return [{ start: nestedStart, end: nestedEnd }];
    }),
    paragraphSpan: { start: paragraphStart, end: paragraphEnd },
  };
};

describe.each(Object.values(allFormatActions).flat())(
  "format action %j",
  (action) => {
    test("formatting preserves document text and inline block structure", () => {
      const bodies = fc.oneof(
        fc
          .string({
            unit: "grapheme",
            minLength: GENERATED_MIN_SCALARS,
            maxLength: GENERATED_MAX_PARAGRAPH_SCALARS,
          })
          .filter((body) => !/[\r\n]/u.test(body)),
        fc.constantFrom(
          "# Notice",
          "> quote",
          "- item",
          "1. one",
          "[label](https://example.test/)",
          "[same](https://updated.test/)",
          "https://example.test/",
          "é **nested** 😀",
          "text `code` &amp; more",
        ),
      );
      const paragraphs = fc
        .record({
          body: bodies,
          format: fc.constantFrom(...INLINE_FORMATS),
          quoteDepth: fc.integer({ min: 0, max: GENERATED_MAX_QUOTE_DEPTH }),
        })
        .map(formattedParagraph)
        .filter((value) => value !== undefined);
      let proposed = false;
      assertProperty(
        "formatting preserves document text and inline block structure",
        fc.property(paragraphs, (paragraph) => {
          let firstBlock: BlockTree = { type: "paragraph" };
          for (let level = 0; level < paragraph.quoteDepth; level++) {
            firstBlock = { type: "blockquote", children: [firstBlock] };
          }
          const expectedBlocks = {
            type: "root",
            children: [firstBlock, { type: "paragraph" }],
          };
          expect(parsedBlockTree(paragraph.tree)).toEqual(expectedBlocks);
          const spans =
            action.format === CHAT_MESSAGE_EDIT_FORMAT.style
              ? [paragraph.paragraphSpan]
              : paragraph.inlineSpans;
          for (const span of spans) {
            const result = formatAnswerSpan({
              source: paragraph.source,
              ...span,
              action,
            });
            switch (result.status) {
              case "unsupported":
                break;
              case "unchanged":
                expect(result).toEqual({ status: "unchanged" });
                expect(renderedText(parsedMarkdown(paragraph.source))).toBe(
                  renderedText(paragraph.tree),
                );
                break;
              case "proposal": {
                proposed = true;
                const candidate =
                  paragraph.source.slice(0, result.start) +
                  result.replacement +
                  paragraph.source.slice(result.end);
                const parsed = parsedMarkdown(candidate);
                expect(renderedText(parsed)).toBe(renderedText(paragraph.tree));
                const expectedLinks = linkDestinations(paragraph.tree);
                if (action.format === CHAT_MESSAGE_EDIT_FORMAT.link) {
                  const existing = selectedMarkdownLinkUrl({
                    source: paragraph.source,
                    ...span,
                  });
                  if (existing !== undefined) {
                    const index = expectedLinks.indexOf(existing);
                    if (index === -1) {
                      panic(
                        "Expected selected destination in the original document",
                      );
                    }
                    expectedLinks.splice(index, 1);
                  }
                  if (action.intent === CHAT_MESSAGE_LINK_INTENT.set) {
                    expectedLinks.push(action.url);
                  }
                }
                expect(linkDestinations(parsed)).toEqual(
                  expectedLinks.toSorted(),
                );
                if (action.format !== CHAT_MESSAGE_EDIT_FORMAT.style) {
                  expect(parsedBlockTree(parsed)).toEqual(expectedBlocks);
                }
                break;
              }
              default:
                result satisfies never;
            }
          }
        }),
        { numRuns: 300 },
      );
      expect(proposed).toBe(true);
    });
  },
);

test.each([
  "mailto:viewer@example.test",
  "ftp://example.test/file",
  "relative/path",
  "",
])(
  "existing destination %s can be detected and removed without being valid to set",
  (url) => {
    const source = `[Email](${url})`;
    const selection = { source, start: 1, end: 6 };
    expect(selectedMarkdownLinkUrl(selection)).toBe(url);
    expect(
      formatAnswerSpan({
        ...selection,
        action: { format: "link", intent: "set", url },
      }),
    ).toEqual({ status: "unsupported", reason: "invalid-url" });
    const result = formatAnswerSpan({
      ...selection,
      action: { format: "link", intent: "remove" },
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") {
      return;
    }
    const candidate =
      source.slice(0, result.start) +
      result.replacement +
      source.slice(result.end);
    expect(parsedMarkdown(candidate).children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "Email" }] },
    ]);
  },
);

test("removing links refuses positionless autolinks from escaped labels", () => {
  const label = "https\\://example\\.test";
  const source = `[${label}](https://example.test)`;
  const paragraph = parsedMarkdown(label).children.at(0);
  expect(paragraph?.type).toBe("paragraph");
  if (paragraph?.type !== "paragraph") {
    return;
  }
  const relinked = paragraph.children.at(0);
  expect(relinked?.type).toBe("link");
  expect(relinked?.position).toBeUndefined();
  expect(renderedText(parsedMarkdown(label))).toBe("https://example.test");
  expect(
    formatAnswerSpan({
      source,
      start: 1,
      end: 1 + label.length,
      action: { format: "link", intent: "remove" },
    }),
  ).toEqual({ status: "unsupported", reason: "autolink-label" });
});

test("inline formatting refuses new positionless links when text and block structure remain unchanged", () => {
  const source = "**https\\:**//example.test";
  const original = parsedMarkdown(source);
  expect(linkDestinations(original)).toEqual([]);
  const start = 2;
  const end = source.indexOf("**", start);
  expect(end).toBeGreaterThan(start);
  const unsafeCandidate = source.slice(start, end) + source.slice(end + 2);
  const changed = parsedMarkdown(unsafeCandidate);
  expect(renderedText(changed)).toBe(renderedText(original));
  expect(parsedBlockTree(changed)).toEqual(parsedBlockTree(original));
  expect(linkDestinations(changed)).toEqual(["https://example.test"]);
  const positionless = markdownDescendants(changed).find(
    (node) => node.type === "link",
  );
  expect(positionless?.type).toBe("link");
  expect(positionless?.position).toBeUndefined();
  expect(
    formatAnswerSpan({ source, start, end, action: { format: "bold" } }),
  ).toEqual({ status: "unsupported", reason: "meaning-changed" });
});

test.each(["é", " ", "😀"])(
  "link setting refuses serialized URLs exceeding the limit with %j paths",
  (unit) => {
    const prefix = "https://example.test/";
    const repetitions = Math.floor(
      (CHAT_MESSAGE_EDIT_URL_MAX_LENGTH - prefix.length - 1) / unit.length,
    );
    const url = `${prefix}${unit.repeat(repetitions)}x`;
    expect(url.length).toBeLessThanOrEqual(CHAT_MESSAGE_EDIT_URL_MAX_LENGTH);
    expect(new URL(url).href.length).toBeGreaterThan(
      CHAT_MESSAGE_EDIT_URL_MAX_LENGTH,
    );
    expect(
      formatAnswerSpan({
        source: "label",
        start: 0,
        end: "label".length,
        action: { format: "link", intent: "set", url },
      }),
    ).toEqual({ status: "unsupported", reason: "invalid-url" });
  },
);

test("link setting accepts a serialized URL at the contract length limit", () => {
  const prefix = "https://example.test/";
  const url = `${prefix}${"a".repeat(CHAT_MESSAGE_EDIT_URL_MAX_LENGTH - prefix.length)}`;
  expect(new URL(url).href.length).toBe(CHAT_MESSAGE_EDIT_URL_MAX_LENGTH);
  const result = formatAnswerSpan({
    source: "label",
    start: 0,
    end: "label".length,
    action: { format: "link", intent: "set", url },
  });
  expect(result.status).toBe("proposal");
  if (result.status === "proposal") {
    expect(result.edit).toMatchObject({ intent: "set", url });
  }
});
