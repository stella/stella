import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { JSONContent } from "@tiptap/core";
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { generateHTML, generateJSON } = await import("@tiptap/core");
const { htmlToMarkdown } = await import("@stll/chat/html-to-markdown");
const { createChatComposerSchemaExtensions } =
  await import("@/components/chat-composer-schema");
const { createUserMessageEditDraft } =
  await import("./user-message-edit.logic");
const { mentionAttrsToHref, mentionTagAttrs } =
  await import("@/components/references/reference.logic");

afterAll(async () => {
  await unregisterDomEnvironment();
});

const extensions = createChatComposerSchemaExtensions({
  onChip: () => undefined,
  onCredential: () => undefined,
});

// A message the composer can hold: paragraphs of lines (a line break between
// lines), each line words, bold words, reference chips and skill chips. The
// generated words include everything a line can start with that Markdown
// would read as structure.

type MentionAttrs = {
  category: string;
  id: string;
  label: string;
  sourceWorkspaceId: string | null;
};

type Inline =
  | { kind: "bold" | "text"; text: string }
  | { attrs: MentionAttrs; kind: "mention" }
  | { kind: "skill"; label: string; slug: string };

/** Words a user types: line starts Markdown would read as structure,
 *  escapable characters, entities, diacritics and other scripts. */
const WORDS: readonly string[] = [
  "Parties",
  "term",
  "the",
  "NDA",
  "1.",
  "2)",
  "-",
  "+",
  "*",
  "#",
  "##",
  ">",
  "---",
  "===",
  "!",
  "`code`",
  "<3",
  "<b>",
  "<https://example.com>",
  "2 * 3",
  "a_b",
  "&amp;",
  "price & terms",
  '"quoted"',
  "[x](y)",
  "\\",
  "|",
  "~",
  "Žluťoučký",
  "kůň",
  "日本語",
  "مرحبا",
  "https://example.com/a_b?x=1&y=2",
];

const LABELS: readonly string[] = ["Acme", "NDA.docx", "Žluťoučký kůň", "日本"];

const IDS: readonly string[] = [
  "018f0000-0000-7000-8000-0000000000d1",
  "018f0000-0000-7000-8000-0000000000d2",
];

const SLUGS: readonly string[] = ["review", "draft-nda"];

/** One to `most` values of `item`. */
const someOf = <T>(item: fc.Arbitrary<T>, most: number): fc.Arbitrary<T[]> =>
  fc
    .tuple(item, fc.array(item))
    .map(([first, rest]) => [first, ...rest].slice(0, most));

const words = someOf(fc.constantFrom(...WORDS), 3).map((picked) =>
  picked.join(" "),
);

const mention: fc.Arbitrary<Inline> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...IDS),
      fc.constantFrom(...LABELS),
      fc.option(fc.constantFrom(...IDS), { nil: null }),
    )
    .map(([id, label, sourceWorkspaceId]) => ({
      attrs: { category: "entity", id, label, sourceWorkspaceId },
      kind: "mention" as const,
    })),
  fc
    .tuple(fc.constantFrom(...IDS), fc.constantFrom(...LABELS))
    .map(([id, label]) => ({
      attrs: { category: "workspace", id, label, sourceWorkspaceId: null },
      kind: "mention" as const,
    })),
);

const inline: fc.Arbitrary<Inline> = fc.oneof(
  words.map((text) => ({ kind: "text" as const, text })),
  words.map((text) => ({ kind: "bold" as const, text })),
  mention,
  fc
    .tuple(fc.constantFrom(...SLUGS), fc.constantFrom(...LABELS))
    .map(([slug, label]) => ({ kind: "skill" as const, label, slug })),
);

const messageArbitrary = someOf(someOf(someOf(inline, 4), 3), 3);

const inlineJson = (item: Inline): JSONContent => {
  switch (item.kind) {
    case "text":
      return { type: "text", text: item.text };
    case "bold":
      return { type: "text", text: item.text, marks: [{ type: "bold" }] };
    case "mention":
      return { type: "mention", attrs: { ...item.attrs } };
    case "skill":
      return {
        type: "pastedText",
        attrs: { label: item.label, source: "skill", text: item.slug },
      };
    default:
      item satisfies never;
      return expect.unreachable("Unhandled inline");
  }
};

/** The composer document of a generated message. */
const composerDocument = (
  paragraphs: readonly (readonly (readonly Inline[])[])[],
): JSONContent => ({
  type: "doc",
  content: paragraphs.map((lines) => ({
    type: "paragraph",
    content: lines.flatMap((line, lineIndex) => [
      ...(lineIndex === 0 ? [] : [{ type: "hardBreak" }]),
      ...line.flatMap((item, itemIndex) => [
        ...(itemIndex === 0 ? [] : [{ type: "text", text: " " }]),
        inlineJson(item),
      ]),
    ]),
  })),
});

/**
 * What the server stores for composer markup: each reference chip as the
 * link it persists (`replaceMentionsWithAnchors`), the unknown
 * `<pasted-text>` wrapper unwrapped by the sanitizer, then the shared
 * HTML-to-Markdown conversion the API runs.
 */
const storedMarkdown = (html: string): string => {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const chip of Array.from(body.querySelectorAll("entity-mention"))) {
    const anchor = body.ownerDocument.createElement("a");
    anchor.setAttribute(
      "href",
      mentionAttrsToHref(mentionTagAttrs((name) => chip.getAttribute(name))) ??
        expect.unreachable("A reference href"),
    );
    anchor.textContent =
      chip instanceof HTMLElement ? (chip.dataset["label"] ?? "") : "";
    chip.replaceWith(anchor);
  }
  for (const wrapper of Array.from(body.querySelectorAll("pasted-text"))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  return htmlToMarkdown(body.innerHTML);
};

// What a message is, compared across forms: its paragraphs, and in each its
// text runs (bold or not), line breaks, reference chips (the reference they
// name and their label) and skill chips, in order.

type Piece =
  | { bold: boolean; kind: "text"; text: string }
  | { kind: "break" }
  | { href: string; kind: "reference"; label: string }
  | { kind: "skill"; label: string; slug: string };

const attrString = (attrs: JSONContent["attrs"], name: string): string => {
  const value: unknown = attrs?.[name];
  return typeof value === "string" ? value : "";
};

/**
 * Spaces at the edge of a line, and runs of them, are not content: markup
 * readers and the server's Markdown writer both drop and collapse them. Every
 * other space is kept.
 */
const withoutEdgeSpaces = (pieces: readonly Piece[]): Piece[] =>
  pieces
    .map((piece, index): Piece => {
      if (piece.kind !== "text") {
        return piece;
      }
      const startsLine = index === 0 || pieces[index - 1]?.kind === "break";
      const endsLine =
        index === pieces.length - 1 || pieces[index + 1]?.kind === "break";
      let text = piece.text.replaceAll(/ {2,}/gu, " ");
      if (startsLine) {
        text = text.trimStart();
      }
      if (endsLine) {
        text = text.trimEnd();
      }
      return { ...piece, text };
    })
    .filter((piece) => piece.kind !== "text" || piece.text.length > 0);

const piecesOf = (paragraph: JSONContent): Piece[] => {
  const pieces: Piece[] = [];
  for (const node of paragraph.content ?? []) {
    const last = pieces.at(-1);
    if (node.type === "text") {
      const bold = (node.marks ?? []).some((mark) => mark.type === "bold");
      const text = node.text ?? "";
      if (last?.kind === "text" && last.bold === bold) {
        pieces[pieces.length - 1] = { ...last, text: last.text + text };
      } else {
        pieces.push({ bold, kind: "text", text });
      }
    } else if (node.type === "hardBreak") {
      pieces.push({ kind: "break" });
    } else if (node.type === "mention") {
      pieces.push({
        href:
          mentionAttrsToHref(node.attrs) ??
          expect.unreachable("A reference href"),
        kind: "reference",
        label: attrString(node.attrs, "label"),
      });
    } else {
      pieces.push({
        kind: "skill",
        label: attrString(node.attrs, "label"),
        slug: attrString(node.attrs, "text"),
      });
    }
  }
  return withoutEdgeSpaces(pieces);
};

const meaningOfDocument = (doc: JSONContent): Piece[][] =>
  (doc.content ?? []).map(piecesOf);

/** Markup as the composer's schema reads it, paragraph by paragraph. */
const meaningOf = (html: string): Piece[][] =>
  meaningOfDocument(generateJSON(html, extensions));

const STORED_FORMS = [
  { form: "composer markup", store: (html: string) => html },
  { form: "stored Markdown", store: storedMarkdown },
] as const;

/** Opens a stored message in the edit form's editor model. */
const openForEdit = (stored: string): JSONContent => {
  const { content } = createUserMessageEditDraft(
    { parts: [{ type: "text", content: stored }] },
    () => "attachment",
  );
  return typeof content === "string"
    ? generateJSON(content, extensions)
    : content;
};

const isChip = (node: JSONContent): boolean =>
  node.type === "mention" || node.type === "pastedText";

/** `doc` without its `removed`-th chip, counted across paragraphs. */
const withoutChip = (doc: JSONContent, removed: number): JSONContent => {
  let chipIndex = -1;
  return {
    ...doc,
    content: (doc.content ?? []).map((paragraph) => ({
      ...paragraph,
      content: (paragraph.content ?? []).filter((node) => {
        if (!isChip(node)) {
          return true;
        }
        chipIndex += 1;
        return chipIndex !== removed;
      }),
    })),
  };
};

const chipCount = (doc: JSONContent): number =>
  (doc.content ?? []).flatMap((paragraph) =>
    (paragraph.content ?? []).filter((node) => isChip(node)),
  ).length;

describe("a sent message reopened in the composer", () => {
  test("a sent message reopened and sent back unchanged keeps its paragraphs, lines, bold text and chips", () => {
    assertProperty(
      "a sent message reopened and sent back unchanged keeps its paragraphs, lines, bold text and chips",
      fc.property(messageArbitrary, (message) => {
        const original = composerDocument(message);
        const sent = generateHTML(original, extensions);
        for (const { store } of STORED_FORMS) {
          const resent = generateHTML(openForEdit(store(sent)), extensions);
          // Against the document the user wrote, not a re-read of its
          // markup: a loss in reading markup must not cancel out.
          expect(meaningOf(resent)).toEqual(meaningOfDocument(original));
        }
      }),
    );
  });

  test("deleting one chip of a reopened message removes exactly that reference", () => {
    assertProperty(
      "deleting one chip of a reopened message removes exactly that reference",
      fc.property(messageArbitrary, fc.nat(), (message, pick) => {
        const original = composerDocument(message);
        const sent = generateHTML(original, extensions);
        const chips = chipCount(original);
        if (chips === 0) {
          return;
        }
        const removed = pick % chips;
        for (const { store } of STORED_FORMS) {
          const resent = generateHTML(
            withoutChip(openForEdit(store(sent)), removed),
            extensions,
          );
          expect(meaningOf(resent)).toEqual(
            meaningOfDocument(withoutChip(original, removed)),
          );
        }
      }),
    );
  });
});
