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

const linkChip = (href: string, label: string): UserMessageEditChip | null => {
  if (href.startsWith(SKILL_REF_HREF_PREFIX)) {
    return {
      html: `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
      token: `@${label}`,
    };
  }
  const parsed = referenceFromHref(href, label);
  if (parsed?.type !== "reference") {
    return null;
  }
  const html = referenceMarkup(href, parsed.reference);
  return html === null ? null : { html, token: `@${label}` };
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
 * The stored message's markdown as the plain text the user typed. Formatting
 * marks are dropped; a link to a stella reference becomes a chip token.
 */
const flattenMarkdown = (
  nodes: readonly MarkdownNode[],
  separator: string,
  chips: UserMessageEditChip[],
): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case "break":
          return "\n";
        case "thematicBreak":
          return "---";
        case "image":
          return node.alt ?? "";
        case "link": {
          const label = flattenMarkdown(node.children, "", chips);
          const chip = linkChip(node.url, label);
          if (chip !== null) {
            chips.push(chip);
            return chip.token;
          }
          return label === node.url ? node.url : `${label} (${node.url})`;
        }
        case "listItem": {
          const body = flattenMarkdown(node.children, "\n", chips);
          return node.checked === null || node.checked === undefined
            ? body
            : `[${node.checked ? "x" : " "}] ${body}`;
        }
        case "list":
          return node.children
            .map((item, itemIndex) => {
              const marker = node.ordered
                ? `${String((node.start ?? 1) + itemIndex)}. `
                : "- ";
              return `${marker}${flattenMarkdown([item], "", chips)}`;
            })
            .join("\n");
        case "heading":
          return `${"#".repeat(node.depth)} ${flattenMarkdown(node.children, "", chips)}`;
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
  listItem: "LI",
  mention: "ENTITY-MENTION",
} as const;

const LIST_TAGS = new Set(["UL", "OL"]);
const BLOCK_TAGS = new Set(["P", "DIV", "BLOCKQUOTE", "PRE", ...LIST_TAGS]);

/**
 * A just-sent message still holds the composer's markup until the stored copy
 * replaces it. Its mention tags are already composer markup, kept verbatim.
 */
const flattenComposerHtml = (
  html: string,
  chips: UserMessageEditChip[],
): string => {
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
        const chip = {
          html: tag instanceof Element ? tag.outerHTML : "",
          token: `@${label}`,
        };
        chips.push(chip);
        return (
          chip.token +
          Array.from(node.childNodes, (child) => visit(child)).join("")
        );
      }
      case TAG_NAME.anchor: {
        const label = node.textContent ?? "";
        const href = node.getAttribute("href") ?? "";
        const chip = linkChip(href, label);
        if (chip === null) {
          return label;
        }
        chips.push(chip);
        return chip.token;
      }
      case TAG_NAME.listItem:
        return `- ${Array.from(node.childNodes, (child) => visit(child)).join("")}`;
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

const isComposerHtml = (content: string): boolean =>
  content.trimStart().startsWith("<");

/** The text the edit form starts from, with the chips its tokens stand for. */
export const userMessageEditText = (
  content: string,
): { chips: UserMessageEditChip[]; text: string } => {
  const chips: UserMessageEditChip[] = [];
  if (isComposerHtml(content)) {
    return { chips, text: flattenComposerHtml(content, chips) };
  }
  const tree = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return { chips, text: flattenMarkdown(tree.children, "\n\n", chips).trim() };
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
  const texts: string[] = [];
  const chips: UserMessageEditChip[] = [];
  const attachments: UserMessageEditAttachment[] = [];
  for (const part of message.parts) {
    if (isEditAttachmentPart(part)) {
      attachments.push({ id: createId(), part });
    } else if (part.type === "text") {
      const editable = userMessageEditText(part.content);
      texts.push(editable.text);
      chips.push(...editable.chips);
    }
  }
  return { attachments, chips, text: texts.join("\n\n") };
};

/** Typed text as composer markup: a blank line starts a paragraph, a line
 *  break stays a line break. */
const textToComposerHtml = (text: string): string =>
  escapeHtml(text)
    .replaceAll(/\n{2,}/gu, "</p><p>")
    .replaceAll("\n", "<br>");

/** The draft's text as composer markup, each chip whose token remains back
 *  in its place, in order. */
export const userMessageEditHtml = ({
  chips,
  text,
}: Pick<UserMessageEditDraft, "chips" | "text">): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  // Chips are inline, so the text between them carries every paragraph
  // and line break; each stretch converts on its own.
  let html = "";
  let cursor = 0;
  for (const chip of chips) {
    const at = trimmed.indexOf(chip.token, cursor);
    if (at === -1) {
      continue;
    }
    html += textToComposerHtml(trimmed.slice(cursor, at)) + chip.html;
    cursor = at + chip.token.length;
  }
  html += textToComposerHtml(trimmed.slice(cursor));
  return `<p>${html}</p>`;
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
  const html = userMessageEditHtml(draft);
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
