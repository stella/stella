import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const {
  composeUserMessageEdit,
  createUserMessageEditDraft,
  findUserMessageEditChipSpans,
} = await import("./user-message-edit.logic");
const { isReferenceHref, mentionAttrsToHref, mentionTagAttrs } =
  await import("@/components/references/reference.logic");

afterAll(async () => {
  await unregisterDomEnvironment();
});

// A message the composer can send, as a document of blocks and inlines, and
// the two forms an edit opens it from: the composer's own markup (a message
// just sent) and the Markdown the server stores for it.

type ReferenceAttrs = { category: "entity" | "workspace"; id: string };

type Inline =
  | { kind: "text"; text: string }
  | { kind: "code" | "em" | "strong"; text: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "autolink"; href: string }
  | { attrs: ReferenceAttrs; kind: "reference"; label: string };

type Block =
  | { inlines: Inline[]; kind: "heading" | "paragraph" | "quote" }
  | { items: Inline[][]; kind: "list"; ordered: boolean }
  | { kind: "code"; text: string };

/** Words a user types: diacritics, other scripts, Markdown and HTML
 *  characters, and text that spells a chip token. */
const WORDS: readonly string[] = [
  "Ask",
  "about",
  "the",
  "NDA",
  "Žluťoučký",
  "kůň",
  "naïve",
  "日本語",
  "مرحبا",
  "<3",
  "<b>",
  "2 * 3",
  "a_b",
  "price & terms",
  '"quoted"',
  "[x](y)",
  "@Acme",
  "@Acme (2)",
  "(2)",
  "@NDA.docx",
];

const LABELS: readonly string[] = ["Acme", "NDA.docx", "Žluťoučký kůň", "日本"];

const REFERENCE_IDS: readonly string[] = [
  "018f0000-0000-7000-8000-0000000000d1",
  "018f0000-0000-7000-8000-0000000000d2",
  "018f0000-0000-7000-8000-0000000000d3",
];

const LINK_HREFS: readonly string[] = [
  "https://example.com/terms",
  "https://example.cz/smlouva?id=1&v=2",
  "mailto:office@example.com",
];

const AUTOLINK_HREFS: readonly string[] = [
  "https://example.com/terms",
  "https://example.cz/smlouva?id=1&v=2",
];

/** One to `most` values of `item`. */
const someOf = <T>(item: fc.Arbitrary<T>, most: number): fc.Arbitrary<T[]> =>
  fc
    .tuple(item, fc.array(item))
    .map(([first, rest]) => [first, ...rest].slice(0, most));

const words = someOf(fc.constantFrom(...WORDS), 3).map((picked) =>
  picked.join(" "),
);

const inline: fc.Arbitrary<Inline> = fc.oneof(
  words.map((text) => ({ kind: "text", text }) as const),
  fc
    .tuple(fc.constantFrom("code", "em", "strong"), words)
    .map(([kind, text]) => ({ kind, text })),
  fc
    .tuple(fc.constantFrom(...LINK_HREFS), words)
    .map(([href, label]) => ({ href, kind: "link", label }) as const),
  fc
    .constantFrom(...AUTOLINK_HREFS)
    .map((href) => ({ href, kind: "autolink" }) as const),
  fc
    .tuple(
      fc.constantFrom("entity", "workspace"),
      fc.constantFrom(...REFERENCE_IDS),
      fc.constantFrom(...LABELS),
    )
    .map(
      ([category, id, label]) =>
        ({ attrs: { category, id }, kind: "reference", label }) as const,
    ),
);

const inlines = someOf(inline, 5);

const block: fc.Arbitrary<Block> = fc.oneof(
  fc
    .tuple(fc.constantFrom("heading", "paragraph", "quote"), inlines)
    .map(([kind, content]) => ({ inlines: content, kind })),
  fc
    .tuple(fc.boolean(), someOf(inlines, 3))
    .map(([ordered, items]) => ({ items, kind: "list", ordered }) as const),
  words.map((text) => ({ kind: "code", text }) as const),
);

const documentArbitrary = someOf(block, 4);

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The characters the server's Markdown writer escapes in text. */
const escapeMarkdown = (text: string): string =>
  text.replaceAll(/(?<character>[\\`*_~[\]<>|])/gu, "\\$<character>");

const referenceHref = (attrs: ReferenceAttrs): string =>
  mentionAttrsToHref(attrs) ?? expect.unreachable("A reference href");

const inlineHtml = (item: Inline): string => {
  switch (item.kind) {
    case "text":
      return escapeHtml(item.text);
    case "code":
    case "em":
    case "strong":
      return `<${item.kind}>${escapeHtml(item.text)}</${item.kind}>`;
    case "link":
      return `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
    case "autolink":
      return `<a href="${escapeHtml(item.href)}">${escapeHtml(item.href)}</a>`;
    case "reference":
      return `<entity-mention data-id="${item.attrs.id}" data-label="${escapeHtml(item.label)}" data-category="${item.attrs.category}"></entity-mention>`;
    default:
      item satisfies never;
      return expect.unreachable("Unhandled inline");
  }
};

const inlineMarkdown = (item: Inline): string => {
  switch (item.kind) {
    case "text":
      return escapeMarkdown(item.text);
    case "code":
      return `\`${item.text}\``;
    case "em":
      return `*${escapeMarkdown(item.text)}*`;
    case "strong":
      return `**${escapeMarkdown(item.text)}**`;
    case "link":
      return `[${escapeMarkdown(item.label)}](${item.href})`;
    case "autolink":
      return `<${item.href}>`;
    case "reference":
      return `[${escapeMarkdown(item.label)}](${referenceHref(item.attrs)})`;
    default:
      item satisfies never;
      return expect.unreachable("Unhandled inline");
  }
};

const joinInlines = (
  content: readonly Inline[],
  render: (item: Inline) => string,
): string => content.map(render).join(" ");

/** The composer's serialization of the document. */
const composerHtml = (blocks: readonly Block[]): string =>
  blocks
    .map((item) => {
      switch (item.kind) {
        case "paragraph":
          return `<p>${joinInlines(item.inlines, inlineHtml)}</p>`;
        case "heading":
          return `<h2>${joinInlines(item.inlines, inlineHtml)}</h2>`;
        case "quote":
          return `<blockquote><p>${joinInlines(item.inlines, inlineHtml)}</p></blockquote>`;
        case "list": {
          const tag = item.ordered ? "ol" : "ul";
          const entries = item.items
            .map((entry) => `<li><p>${joinInlines(entry, inlineHtml)}</p></li>`)
            .join("");
          return `<${tag}>${entries}</${tag}>`;
        }
        case "code":
          return `<pre><code>${escapeHtml(item.text)}</code></pre>`;
        default:
          item satisfies never;
          return expect.unreachable("Unhandled block");
      }
    })
    .join("");

/** The Markdown the server stores for the document. */
const storedMarkdown = (blocks: readonly Block[]): string =>
  blocks
    .map((item) => {
      switch (item.kind) {
        case "paragraph":
          return joinInlines(item.inlines, inlineMarkdown);
        case "heading":
          return `## ${joinInlines(item.inlines, inlineMarkdown)}`;
        case "quote":
          return `> ${joinInlines(item.inlines, inlineMarkdown)}`;
        case "list":
          return item.items
            .map(
              (entry, index) =>
                `${item.ordered ? `${String(index + 1)}.` : "-"} ${joinInlines(entry, inlineMarkdown)}`,
            )
            .join("\n");
        case "code":
          return `\`\`\`\n${item.text}\n\`\`\``;
        default:
          item satisfies never;
          return expect.unreachable("Unhandled block");
      }
    })
    .join("\n\n");

// What a message means, whatever form carries it: its text, its links with
// their destinations, and its references, in order. Formatting and block
// layout are not part of it; the edit is a plain-text editor.

type Meaning =
  | { kind: "text"; text: string }
  | { href: string; kind: "link"; text: string }
  | { href: string; kind: "reference" };

const collapse = (text: string): string => text.replaceAll(/\s+/gu, " ");

/** One canonical form: runs of text merged, whitespace collapsed and trimmed
 *  around links and references, empty runs dropped. */
const normalize = (items: readonly Meaning[]): Meaning[] => {
  const merged: Meaning[] = [];
  for (const item of items) {
    const last = merged.at(-1);
    if (item.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: last.text + item.text };
    } else {
      merged.push(item);
    }
  }
  const canonical: Meaning[] = [];
  for (const item of merged) {
    if (item.kind === "reference") {
      canonical.push(item);
    } else if (item.kind === "link") {
      canonical.push({ ...item, text: collapse(item.text).trim() });
    } else if (collapse(item.text).trim().length > 0) {
      canonical.push({ kind: "text", text: collapse(item.text).trim() });
    }
  }
  return canonical;
};

/** `items` without its `removed`-th link or reference. */
const withoutChip = (items: readonly Meaning[], removed: number): Meaning[] => {
  let chipIndex = -1;
  return normalize(
    items.filter((item) => {
      if (item.kind === "text") {
        return true;
      }
      chipIndex += 1;
      return chipIndex !== removed;
    }),
  );
};

const BLOCK_ELEMENTS = new Set([
  "P",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const meaningOfHtml = (html: string): Meaning[] => {
  const items: Meaning[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      items.push({ kind: "text", text: node.textContent ?? "" });
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (node.tagName === "ENTITY-MENTION") {
      items.push({
        href:
          mentionAttrsToHref(
            mentionTagAttrs((name) => node.getAttribute(name)),
          ) ?? expect.unreachable("A mention href"),
        kind: "reference",
      });
      return;
    }
    if (node.tagName === "A") {
      items.push({
        href: node.getAttribute("href") ?? "",
        kind: "link",
        text: node.textContent ?? "",
      });
      return;
    }
    if (node.tagName === "BR" || BLOCK_ELEMENTS.has(node.tagName)) {
      items.push({ kind: "text", text: " " });
    }
    for (const child of node.childNodes) {
      visit(child);
    }
    if (BLOCK_ELEMENTS.has(node.tagName)) {
      items.push({ kind: "text", text: " " });
    }
  };
  visit(new DOMParser().parseFromString(html, "text/html").body);
  return items;
};

type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];

const textOfMarkdown = (nodes: readonly MarkdownNode[]): string =>
  nodes
    .map((node) => {
      if ("value" in node) {
        return node.value;
      }
      return "children" in node ? textOfMarkdown(node.children) : "";
    })
    .join("");

const meaningOfMarkdown = (markdown: string): Meaning[] => {
  const items: Meaning[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "link") {
      items.push(
        !node.url.startsWith(SKILL_REF_HREF_PREFIX) && isReferenceHref(node.url)
          ? { href: node.url, kind: "reference" }
          : {
              href: node.url,
              kind: "link",
              text: textOfMarkdown(node.children),
            },
      );
      return;
    }
    if (node.type === "break") {
      items.push({ kind: "text", text: " " });
      return;
    }
    if ("value" in node) {
      // A fenced code block is a block of its own, apart from its neighbours.
      const apart = node.type === "code" ? " " : "";
      items.push({ kind: "text", text: `${apart}${node.value}${apart}` });
      return;
    }
    if ("children" in node) {
      const isBlock = node.type !== "emphasis" && node.type !== "strong";
      if (isBlock) {
        items.push({ kind: "text", text: " " });
      }
      for (const child of node.children) {
        visit(child);
      }
      if (isBlock) {
        items.push({ kind: "text", text: " " });
      }
    }
  };
  for (const node of fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children) {
    visit(node);
  }
  return items;
};

const STORED_FORMS = [
  { form: "composer markup", meaning: meaningOfHtml, render: composerHtml },
  {
    form: "stored Markdown",
    meaning: meaningOfMarkdown,
    render: storedMarkdown,
  },
] as const;

/** Opens `content` in the editor model, as the edit form does. */
const openForEdit = (content: string) => {
  let nextId = 0;
  return createUserMessageEditDraft(
    { parts: [{ type: "text", content }] },
    () => {
      nextId += 1;
      return `attachment-${String(nextId)}`;
    },
  );
};

describe("an edit sent back unchanged", () => {
  test("an edit sent back unchanged keeps the text, links and references of either stored form", () => {
    assertProperty(
      "an edit sent back unchanged keeps the text, links and references of either stored form",
      fc.property(documentArbitrary, (blocks) => {
        for (const { meaning, render } of STORED_FORMS) {
          const content = render(blocks);
          const draft = openForEdit(content);
          const resent = composeUserMessageEdit(draft);
          expect(resent.removedChips).toEqual([]);
          expect(normalize(meaningOfHtml(resent.html))).toEqual(
            normalize(meaning(content)),
          );
        }
      }),
    );
  });

  test("deleting one chip's token removes exactly that reference or link", () => {
    assertProperty(
      "deleting one chip's token removes exactly that reference or link",
      fc.property(documentArbitrary, fc.nat(), (blocks, pick) => {
        for (const { meaning, render } of STORED_FORMS) {
          const content = render(blocks);
          const draft = openForEdit(content);
          const spans = findUserMessageEditChipSpans(draft.chips, draft.text);
          const deleted = spans[pick % Math.max(spans.length, 1)];
          if (deleted === undefined) {
            continue;
          }
          const resent = composeUserMessageEdit({
            chips: draft.chips,
            text:
              draft.text.slice(0, deleted.start) +
              draft.text.slice(deleted.end),
          });
          expect(resent.removedChips).toEqual([deleted.chip]);
          expect(normalize(meaningOfHtml(resent.html))).toEqual(
            withoutChip(meaning(content), spans.indexOf(deleted)),
          );
        }
      }),
    );
  });
});
