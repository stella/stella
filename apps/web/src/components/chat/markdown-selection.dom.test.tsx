import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";
import type { Root } from "hast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { defaultRehypePlugins, Streamdown } from "streamdown";

import { assertProperty } from "@stll/property-testing";

import {
  mapMarkdownSelection,
  normalizeMarkdownSelectionText,
} from "@/components/chat/markdown-selection.logic";
import { rehypeMarkdownSourceOffsets } from "@/components/chat/rehype-markdown-source-offsets";
import { mapAnswerSelection } from "@/features/chat/answer-edit/answer-edit-selection";

GlobalRegistrator.register();
afterAll(async () => await GlobalRegistrator.unregister());

const renderMarkdown = (source: string) => {
  const root = document.createElement("div");
  // safe-html: Streamdown's default rehype sanitize/harden chain renders generated Markdown into a detached test document.
  root.innerHTML = renderToStaticMarkup(
    <Streamdown
      mode="static"
      controls={false}
      parseIncompleteMarkdown={false}
      normalizeHtmlIndentation={false}
      rehypePlugins={[
        ...Object.values(defaultRehypePlugins),
        rehypeMarkdownSourceOffsets,
      ]}
    >
      {source}
    </Streamdown>,
  );
  return root;
};

// Generation budgets bound DOM work, independently of product input limits.
const GENERATED_MIN_ITEMS = 1;
const GENERATED_WORD_MAX_SCALARS = 12;
const GENERATED_BLOCK_MAX_INLINES = 4;
const GENERATED_MAX_BLOCKS = 3;

const word = fc
  .array(fc.constantFrom("a", "z", "č", "é", "ع", "中", "𐐷", "😀"), {
    minLength: GENERATED_MIN_ITEMS,
    maxLength: GENERATED_WORD_MAX_SCALARS,
  })
  .map((letters) => letters.join(""));
const inline = fc
  .tuple(
    word,
    fc.constantFrom(
      "plain",
      "bold",
      "italic",
      "link",
      "code",
      "entity",
      "escape",
      "numeric-entity",
    ),
  )
  .map(([text, type]) => {
    switch (type) {
      case "bold":
        return `**${text}**`;
      case "italic":
        return `*${text}*`;
      case "link":
        return `[${text}](https://example.test/${text})`;
      case "code":
        return `\`${text}\``;
      case "entity":
        return `${text}&amp;${text}`;
      case "escape":
        return `${text}\\*${text}`;
      case "numeric-entity":
        return `${text}&#x1F600;${text}&#269;`;
      case "plain":
        return text;
      default:
        return type satisfies never;
    }
  });
const markdown = fc
  .array(
    fc.tuple(
      fc.array(inline, {
        minLength: GENERATED_MIN_ITEMS,
        maxLength: GENERATED_BLOCK_MAX_INLINES,
      }),
      fc.constantFrom("paragraph", "heading", "list", "quote", "table"),
    ),
    {
      minLength: GENERATED_MIN_ITEMS,
      maxLength: GENERATED_MAX_BLOCKS,
    },
  )
  .map((blocks) =>
    blocks
      .map(([pieces, kind]) => {
        const text = pieces.join(" ");
        switch (kind) {
          case "paragraph":
            return text;
          case "heading":
            return `## ${text}`;
          case "list":
            return `- ${text}\n- another item`;
          case "quote":
            return `> ${text}`;
          case "table":
            return `| ${text} | column |\n| --- | --- |\n| cell | content |`;
          default:
            return kind satisfies never;
        }
      })
      .join("\n\n"),
  );

test("every generated rendered markdown leaf maps to the same stripped source text", () => {
  assertProperty(
    "every generated rendered markdown leaf maps to the same stripped source text",
    fc.property(markdown, (source) => {
      const root = renderMarkdown(source);
      const leaves = root.querySelectorAll("[data-src-start]");
      expect(leaves.length).toBeGreaterThan(0);
      // A missing stamp must fail too; otherwise dropping unsupported syntax
      // from the plugin would make the round-trip property vacuously pass.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        if (node.textContent?.trim()) {
          expect(
            node.parentElement?.closest("[data-src-start]"),
          ).not.toBeNull();
        }
      }
      for (const leaf of leaves) {
        const text = document
          .createTreeWalker(leaf, NodeFilter.SHOW_TEXT)
          .nextNode();
        expect(text).not.toBeNull();
        if (!text) {
          continue;
        }
        const length = text.textContent?.length ?? 0;
        const scalars = Array.from(text.textContent ?? "");
        const middle = scalars
          .slice(0, Math.floor(scalars.length / 2))
          .join("").length;
        for (const offset of new Set([0, middle])) {
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, length);
          if (!normalizeMarkdownSelectionText(range.toString())) {
            continue;
          }
          const mapped = mapMarkdownSelection({ root, source, range });
          expect(mapped.status).toBe("mapped");
          if (mapped.status !== "mapped") {
            continue;
          }
          const parsed = fromMarkdown(source.slice(mapped.start, mapped.end));
          const nodes = parsed.children.toReversed();
          const pieces: string[] = [];
          for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
            if (node.type === "text" || node.type === "inlineCode") {
              pieces.push(node.value);
            }
            if ("children" in node) {
              nodes.push(...node.children.toReversed());
            }
          }
          expect(normalizeMarkdownSelectionText(pieces.join(""))).toBe(
            normalizeMarkdownSelectionText(range.toString()),
          );
        }
      }
    }),
    { numRuns: 40 },
  );
}, 20_000);

test("refuses rendered replacements, stale source and cross-root selections", () => {
  const source = "**original**";
  const root = renderMarkdown(source);
  const text = root.querySelector("[data-src-start]")?.firstChild;
  expect(text).not.toBeNull();
  if (!text) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(text);
  expect(
    mapMarkdownSelection({ root, source: "**different**", range }).status,
  ).toBe("unsupported");
  expect(
    mapMarkdownSelection({ root: document.createElement("div"), source, range })
      .status,
  ).toBe("unsupported");
  text.textContent = "replacement";
  expect(mapMarkdownSelection({ root, source, range }).status).toBe(
    "unsupported",
  );
});

test("refuses selections crossing answer parts or splitting Unicode scalars", () => {
  const source = "😀 first";
  const first = renderMarkdown(source);
  const second = renderMarkdown("second");
  const message = document.createElement("div");
  message.append(first, second);
  const firstText = first.querySelector("[data-src-start]")?.firstChild;
  const secondText = second.querySelector("[data-src-start]")?.firstChild;
  expect(firstText).not.toBeNull();
  expect(secondText).not.toBeNull();
  if (!firstText || !secondText) {
    return;
  }
  const range = document.createRange();
  range.setStart(firstText, 1);
  range.setEnd(firstText, 2);
  expect(mapMarkdownSelection({ root: first, source, range }).status).toBe(
    "unsupported",
  );
  range.setStart(firstText, 0);
  range.setEnd(secondText, 6);
  expect(mapMarkdownSelection({ root: first, source, range }).status).toBe(
    "unsupported",
  );
});

test("refuses transformed math, code and restored placeholder text without source anchors", () => {
  for (const source of ["$$x^2$$", "```ts\nvalue\n```", "[PERSON_1]"]) {
    const root = document.createElement("div");
    const rendered = document.createElement("span");
    rendered.textContent = "Rendered replacement";
    root.append(rendered);
    const range = document.createRange();
    range.selectNodeContents(rendered);
    expect(mapMarkdownSelection({ root, source, range }).status).toBe(
      "unsupported",
    );
  }
});

test("maps across nested emphasis without reinterpreting partial markdown delimiters", () => {
  const source = "Before **bold *nested* text** after";
  const root = renderMarkdown(source);
  const first = root.querySelector("strong")?.firstChild?.firstChild;
  const last = root.querySelector("strong")?.lastChild?.firstChild;
  expect(first).not.toBeNull();
  expect(last).not.toBeNull();
  if (!first || !last) {
    return;
  }
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.textContent?.length ?? 0);
  expect(mapMarkdownSelection({ root, source, range })).toEqual({
    status: "mapped",
    start: 9,
    end: 26,
    selectedText: "bold nested text",
  });
});

test.each(["", "0,,1", "0,NaN", "0,-1", "0,1.5", "0,9007199254740992"])(
  "refuses malformed source offsets %s at the DOM boundary",
  (offsets) => {
    const source = "hello";
    const root = renderMarkdown(source);
    const leaf = root.querySelector("[data-src-start]");
    expect(leaf).not.toBeNull();
    if (!(leaf instanceof HTMLElement)) {
      panic("Markdown selection fixture must contain an HTML source anchor");
    }
    Object.assign(leaf.dataset, { srcOffsets: offsets });
    const range = document.createRange();
    range.selectNodeContents(leaf);
    expect(mapMarkdownSelection({ root, source, range }).status).toBe(
      "unsupported",
    );
  },
);

test.each([null, "", " ", "-1", "0.5", "NaN", "9007199254740992", "0"])(
  "validates the answer part index %s before selecting a message part",
  (index) => {
    const source = "hello";
    const root = renderMarkdown(source);
    const messageRoot = document.createElement("div");
    messageRoot.append(root);
    // The attribute is found on the surrounding part even when absent on a
    // nested element; the reader must still reject an invalid part index.
    Object.assign(messageRoot.dataset, { textPartIndex: "" });
    if (index !== null) {
      Object.assign(root.dataset, { textPartIndex: index });
    }
    const leaf = root.querySelector("[data-src-start]");
    expect(leaf).not.toBeNull();
    if (!leaf) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(leaf);
    const selected = mapAnswerSelection({
      message: {
        id: "answer",
        role: "assistant",
        parts: [{ type: "text", content: source }],
      },
      baseRevision: 0,
      messageRoot,
      range,
    });
    expect(selected.status).toBe(index === "0" ? "available" : "unsupported");
  },
);

test("stamps text and element nodes while preserving root doctype and raw nodes", () => {
  const doctype = { type: "doctype" } as const;
  const raw = { type: "raw", value: "<div>raw</div>" } as const;
  const tree = {
    type: "root",
    children: [
      doctype,
      raw,
      {
        type: "text",
        value: "hello",
        position: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 6, offset: 5 },
        },
      },
    ],
  } satisfies Root;
  rehypeMarkdownSourceOffsets()(tree, { value: "hello" });
  expect(tree.children.slice(0, 2)).toEqual([doctype, raw]);
  expect(tree.children.at(2)).toMatchObject({
    type: "element",
    tagName: "span",
    properties: { "data-src-offsets": "0,1,2,3,4,5" },
    children: [{ type: "text", value: "hello" }],
  });
});
