import { panic } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  formatChatSourceScopeId,
  parseChatSourceScopeHref,
  SKILL_REF_HREF_PREFIX,
} from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import type { ChatPastedTextPart } from "@stll/api-contract/chat";

import type {
  ChatAttachmentPart,
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { referenceFromHref } from "@/components/references/reference.logic";
import type { ChatReference } from "@/components/references/reference.logic";
import type { ChatUserMessageInput } from "@/features/chat/chat-runtime";
import { toSafeId } from "@/lib/safe-id";

/**
 * A reference chip of the edited message (a mention, a source, a skill). The
 * text field spells it as `token`; sending writes `html` back in its place,
 * the markup the composer sends for that chip. Deleting the token removes the
 * chip.
 */
export type UserMessageEditChip = {
  html: string;
  token: string;
};

export type UserMessageEditAttachmentPart =
  ChatAttachmentPart | ChatPastedTextPart;

/** An attachment of the edited message, under an id for this edit session. */
export type UserMessageEditAttachment = {
  id: string;
  part: UserMessageEditAttachmentPart;
};

/** The edited message as the edit form holds it. */
export type UserMessageEditDraft = {
  attachments: readonly UserMessageEditAttachment[];
  chips: readonly UserMessageEditChip[];
  text: string;
};

type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const mentionTag = (attrs: {
  category: string;
  id: string;
  label: string;
  sourceWorkspaceId?: string | null | undefined;
}): string => {
  const sourceWorkspace =
    attrs.sourceWorkspaceId === null || attrs.sourceWorkspaceId === undefined
      ? ""
      : ` data-source-workspace-id="${escapeHtml(attrs.sourceWorkspaceId)}"`;
  return `<entity-mention data-id="${escapeHtml(attrs.id)}" data-label="${escapeHtml(attrs.label)}" data-category="${escapeHtml(attrs.category)}"${sourceWorkspace}></entity-mention>`;
};

/** The composer markup for a reference the stored message links to. */
const referenceMarkup = (
  href: string,
  reference: ChatReference,
): string | null => {
  const label = reference.label;
  switch (reference.type) {
    case "entity":
      return mentionTag({
        category: "entity",
        id: reference.entityId,
        label,
        sourceWorkspaceId: reference.matterId,
      });
    case "matter":
      return mentionTag({
        category: "workspace",
        id: reference.matterId,
        label,
      });
    case "decision":
      return reference.locator.type === "ref"
        ? mentionTag({ category: "decision", id: reference.locator.ref, label })
        : null;
    case "corpus":
    case "registry":
    case "connector": {
      const scope = parseChatSourceScopeHref(href);
      return scope === null
        ? null
        : mentionTag({
            category: scope.kind,
            id: formatChatSourceScopeId(scope),
            label,
          });
    }
    case "skill":
      return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    case "user":
      return null;
    default:
      reference satisfies never;
      return panic("Unhandled chat reference");
  }
};

const anchorMarkup = (href: string, label: string): string =>
  `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

/**
 * A link of the message as a chip: the token the text spells it with and the
 * composer markup that sends it back. A link to a stella reference reads as
 * `@label`; any other link keeps its destination, as its bare URL when its
 * text is the URL (an autolink) and as `[label](url)` otherwise.
 */
const linkChip = (
  href: string,
  label: string,
): { html: string; tokenBase: string } => {
  if (href.startsWith(SKILL_REF_HREF_PREFIX)) {
    return { html: anchorMarkup(href, label), tokenBase: `@${label}` };
  }
  const parsed = referenceFromHref(href, label);
  const reference =
    parsed?.type === "reference"
      ? referenceMarkup(href, parsed.reference)
      : null;
  if (reference !== null) {
    return { html: reference, tokenBase: `@${label}` };
  }
  return {
    html: anchorMarkup(href, label),
    tokenBase: label === href ? href : `[${label}](${href})`,
  };
};

/** Where a chip's token stands in an edited text. */
export type UserMessageEditChipSpan = {
  chip: UserMessageEditChip;
  end: number;
  start: number;
};

/**
 * Where the text spells each chip, in text order. Tokens are read left to
 * right, a longer token winning over one it starts with, and each chip is read
 * once; a chip whose token the text no longer spells has no span.
 */
export const findUserMessageEditChipSpans = (
  chips: readonly UserMessageEditChip[],
  text: string,
): UserMessageEditChipSpan[] => {
  const longestFirst = chips.toSorted(
    (left, right) => right.token.length - left.token.length,
  );
  const placed = new Set<UserMessageEditChip>();
  const chipAt = (position: number): UserMessageEditChip | undefined =>
    longestFirst.find(
      (candidate) =>
        !placed.has(candidate) && text.startsWith(candidate.token, position),
    );
  const spans: UserMessageEditChipSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const chip = chipAt(index);
    if (chip === undefined) {
      index += 1;
      continue;
    }
    placed.add(chip);
    spans.push({ chip, end: index + chip.token.length, start: index });
    index += chip.token.length;
  }
  return spans;
};

/**
 * The chips of one edited message: its references and its links. While the
 * message is read, each chip stands in the text as a placeholder; once all of
 * the message's text is known, every chip gets a token that neither another
 * chip nor the text the user typed spells, and that reading the text back
 * finds exactly where the chip stands. `Ask @Acme about` plus a reference
 * labelled Acme reads `Ask @Acme about @Acme (2)`: the literal `@Acme` stays
 * text, and the token names the one reference wherever the user moves it.
 */
type ChipCollector = {
  /** Records a chip spelled `tokenBase` (plus ` (2)`, ` (3)`… where that is
   *  taken) and returns the placeholder that stands for it. */
  add: (tokenBase: string, html: string) => string;
  /** The chips under their tokens, and `texts` joined by `separator` with
   *  each placeholder replaced by its chip's token. */
  finish: (
    texts: readonly string[],
    separator: string,
  ) => {
    chips: UserMessageEditChip[];
    text: string;
  };
};

/** Bounds the token search; each round lengthens one ambiguous token. */
const MAX_TOKEN_ROUNDS_PER_CHIP = 8;

/** A message's text with its chips under candidate tokens, and where each
 *  chip's token was written. */
type BuiltEditText = {
  chips: UserMessageEditChip[];
  starts: number[];
  text: string;
};

/** The first chip reading the text back does not find where it was written,
 *  or -1 when every chip reads back in place. */
const firstMisreadChip = ({ chips, starts, text }: BuiltEditText): number => {
  const found = findUserMessageEditChipSpans(chips, text);
  return chips.findIndex(
    (chip, chipIndex) =>
      found.find((span) => span.chip === chip)?.start !== starts[chipIndex],
  );
};

/** A private-use character none of `sources` contains, to mark placeholders. */
const unusedMarker = (sources: readonly string[]): string => {
  for (let codePoint = 0xe0_00; codePoint <= 0xf8_ff; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (sources.every((source) => !source.includes(marker))) {
      return marker;
    }
  }
  return panic("The message uses every private-use character");
};

const createChipCollector = (sources: readonly string[]): ChipCollector => {
  const marker = unusedMarker(sources);
  const placeholder = new RegExp(`${marker}(\\d+)${marker}`, "gu");
  const pending: { html: string; tokenBase: string }[] = [];
  return {
    add: (tokenBase, html) => {
      pending.push({ html, tokenBase });
      return `${marker}${String(pending.length - 1)}${marker}`;
    },
    finish: (texts, separator) => {
      const template = texts.join(separator);
      // Everything the user typed, each chip a break so no token is read
      // across one.
      const typed = template.replaceAll(placeholder, "\n");
      // Split by the placeholder's capture: typed text at even indexes, a
      // chip's index at odd ones.
      const pieces = template.split(placeholder);
      const build = (copies: readonly number[]): BuiltEditText => {
        const taken = new Set<string>();
        const chips = pending.map(({ html, tokenBase }, chipIndex) => {
          const tokenFor = (copy: number) =>
            copy === 1 ? tokenBase : `${tokenBase} (${String(copy)})`;
          let copy = copies[chipIndex] ?? 1;
          while (taken.has(tokenFor(copy)) || typed.includes(tokenFor(copy))) {
            copy += 1;
          }
          taken.add(tokenFor(copy));
          return { html, token: tokenFor(copy) };
        });
        const starts: number[] = Array.from(pending, () => 0);
        let text = "";
        for (const [pieceIndex, piece] of pieces.entries()) {
          if (pieceIndex % 2 === 0) {
            text += piece;
          } else {
            const chipIndex = Number(piece);
            starts[chipIndex] = text.length;
            text += chips[chipIndex]?.token ?? "";
          }
        }
        return { chips, starts, text };
      };
      // The token a chip gets must be read back at the chip's own place: a
      // token the typed text around another chip completes (`@Acme` before a
      // typed ` (2)`) is lengthened until reading the text finds every chip
      // where it stands.
      const copies = pending.map(() => 1);
      let built = build(copies);
      for (
        let round = 0;
        round < (pending.length + 1) * MAX_TOKEN_ROUNDS_PER_CHIP;
        round += 1
      ) {
        const misread = firstMisreadChip(built);
        if (misread === -1) {
          break;
        }
        copies[misread] = (copies[misread] ?? 1) + 1;
        built = build(copies);
      }
      return { chips: built.chips, text: built.text };
    },
  };
};

/** Children joined the way their parent lays them out. */
const BLOCK_SEPARATOR: Partial<Record<MarkdownNode["type"], string>> = {
  blockquote: "\n\n",
  list: "\n",
  listItem: "\n",
  table: "\n",
  tableRow: " | ",
};

/**
 * The stored message's markdown as the plain text the user typed: its words,
 * its links and its references, each block on its own lines. Formatting
 * (emphasis, headings, list bullets, quotes) is not text and is not carried;
 * every link keeps its destination as a chip.
 */
const flattenMarkdown = (
  nodes: readonly MarkdownNode[],
  separator: string,
  chips: ChipCollector,
): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case "break":
          return "\n";
        case "image":
          return node.alt ?? "";
        case "link": {
          const label = flattenMarkdown(node.children, "", chips);
          const chip = linkChip(node.url, label);
          return chips.add(chip.tokenBase, chip.html);
        }
        default:
          if ("value" in node) {
            return node.value;
          }
          if ("children" in node) {
            return flattenMarkdown(
              node.children,
              BLOCK_SEPARATOR[node.type] ?? "",
              chips,
            );
          }
          // Definitions and footnote markers carry no text of their own.
          return "";
      }
    })
    .join(separator);

const TAG_NAME = {
  anchor: "A",
  break: "BR",
  mention: "ENTITY-MENTION",
} as const;

const LIST_TAGS = new Set(["UL", "OL"]);
const BLOCK_TAGS = new Set(["P", "DIV", "BLOCKQUOTE", "PRE", ...LIST_TAGS]);

/**
 * A just-sent message still holds the composer's markup until the stored copy
 * replaces it. Its mention tags are already composer markup, kept verbatim.
 */
const flattenComposerHtml = (html: string, chips: ChipCollector): string => {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? "";
    }
    if (!(node instanceof HTMLElement)) {
      return "";
    }
    switch (node.tagName) {
      case TAG_NAME.break:
        return "\n";
      case TAG_NAME.mention: {
        const label = node.dataset["label"] ?? "";
        // The composer writes the tag empty; a self-closing tag parses with
        // the text after it as its content, which stays the user's text.
        const tag = node.cloneNode(false);
        const token = chips.add(
          `@${label}`,
          tag instanceof Element ? tag.outerHTML : "",
        );
        return (
          token + Array.from(node.childNodes, (child) => visit(child)).join("")
        );
      }
      case TAG_NAME.anchor: {
        const label = node.textContent ?? "";
        const href = node.getAttribute("href");
        if (href === null) {
          return label;
        }
        const chip = linkChip(href, label);
        return chips.add(chip.tokenBase, chip.html);
      }
      default: {
        const children = Array.from(node.childNodes, (child) => visit(child));
        if (LIST_TAGS.has(node.tagName)) {
          return children.join("\n");
        }
        const holdsBlocks = Array.from(node.childNodes).some(
          (child) => child instanceof Element && BLOCK_TAGS.has(child.tagName),
        );
        return children.join(holdsBlocks ? "\n\n" : "");
      }
    }
  };
  return visit(body)
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
};

/** The block tags the composer's editor serializes its document as. */
const COMPOSER_BLOCK = "(?:p|ul|ol|blockquote|pre|h[1-6])";
const COMPOSER_OPENING = new RegExp(`^<${COMPOSER_BLOCK}(?:\\s[^>]*)?>`, "u");
const COMPOSER_CLOSING = new RegExp(`</${COMPOSER_BLOCK}>$`, "u");

/**
 * Whether a text part still holds the composer's own serialization (a
 * just-sent message, until the stored copy replaces it). The editor always
 * writes its document as block elements, so the part opens with a block tag
 * and closes with one. A stored message is Markdown whose `<` the server
 * escapes, so it never takes that shape: an autolink (`<https://…>`) or a
 * literal `<3` is Markdown, whatever its first character.
 */
const isComposerSerialization = (content: string): boolean => {
  const trimmed = content.trim();
  return COMPOSER_OPENING.test(trimmed) && COMPOSER_CLOSING.test(trimmed);
};

const editableText = (content: string, chips: ChipCollector): string => {
  if (isComposerSerialization(content)) {
    return flattenComposerHtml(content, chips);
  }
  const tree = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return flattenMarkdown(tree.children, "\n\n", chips).trim();
};

/** The text the edit form starts from, with the chips its tokens stand for. */
export const userMessageEditText = (
  content: string,
): { chips: UserMessageEditChip[]; text: string } => {
  const collector = createChipCollector([content]);
  return collector.finish([editableText(content, collector)], "");
};

const isEditAttachmentPart = (
  part: ChatPart,
): part is UserMessageEditAttachmentPart =>
  part.type === "image" ||
  part.type === "document" ||
  isChatPastedTextPart(part);

/** The edit form's starting state for a sent user message. */
export const createUserMessageEditDraft = (
  message: Pick<PersistedChatMessage, "parts">,
  createId: () => string,
): UserMessageEditDraft => {
  const textContents: string[] = [];
  const attachments: UserMessageEditAttachment[] = [];
  for (const part of message.parts) {
    if (isEditAttachmentPart(part)) {
      attachments.push({ id: createId(), part });
    } else if (part.type === "text") {
      textContents.push(part.content);
    }
  }
  // One collector for every text part, so no chip's token is spelled by
  // another chip or by anything the user typed anywhere in the message.
  const collector = createChipCollector(textContents);
  const { chips, text } = collector.finish(
    textContents.map((content) => editableText(content, collector)),
    "\n\n",
  );
  return { attachments, chips, text };
};

/** Typed text as composer markup: a blank line starts a paragraph, a line
 *  break stays a line break. */
const textToComposerHtml = (text: string): string =>
  escapeHtml(text)
    .replaceAll(/\n{2,}/gu, "</p><p>")
    .replaceAll("\n", "<br>");

/**
 * The draft's text as composer markup, with what became of its chips. Each
 * token is read where the edited text spells it, in the edited order, and
 * stands for the one chip it names; a longer token wins over one it starts
 * with. A chip whose token the user deleted is in `removedChips`: deleting
 * the token is how a reference is taken out, so none leaves unaccounted for.
 */
export const composeUserMessageEdit = ({
  chips,
  text,
}: Pick<UserMessageEditDraft, "chips" | "text">): {
  html: string;
  removedChips: UserMessageEditChip[];
} => {
  const trimmed = text.trim();
  const spans = findUserMessageEditChipSpans(chips, trimmed);
  // Chips are inline, so the text between them carries every paragraph and
  // line break; each stretch converts on its own.
  let html = "";
  let stretchStart = 0;
  for (const { chip, end, start } of spans) {
    html += textToComposerHtml(trimmed.slice(stretchStart, start)) + chip.html;
    stretchStart = end;
  }
  html += textToComposerHtml(trimmed.slice(stretchStart));
  const placed = new Set(spans.map(({ chip }) => chip));
  return {
    html: trimmed.length === 0 ? "" : `<p>${html}</p>`,
    removedChips: chips.filter((chip) => !placed.has(chip)),
  };
};

/** Whether the draft would send anything: text or a kept attachment. */
export const hasUserMessageEditContent = (
  draft: UserMessageEditDraft,
): boolean => draft.text.trim().length > 0 || draft.attachments.length > 0;

/**
 * The message the edit sends: the same id as the message it replaces, the
 * edited text as composer markup, and the attachments the user kept.
 */
export const buildEditedUserMessage = ({
  draft,
  messageId,
}: {
  draft: UserMessageEditDraft;
  messageId: string;
}): ChatUserMessageInput => {
  const id = toSafeId<"chatMessage">(messageId);
  // A removed chip is one whose token the user deleted on purpose; the
  // request carries every other chip, wherever the edit moved it.
  const { html } = composeUserMessageEdit(draft);
  const attachments = draft.attachments.map(({ part }) => part);
  if (attachments.length === 0) {
    return { id, content: html };
  }
  if (html.length === 0) {
    return { id, content: attachments };
  }
  return {
    id,
    content: [
      { type: "text", content: html } satisfies ChatPart,
      ...attachments,
    ],
  };
};
