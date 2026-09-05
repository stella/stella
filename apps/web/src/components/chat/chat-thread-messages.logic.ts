import { panic, Result } from "better-result";

import type {
  ChatAnonRestoration,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { ClientOperationError } from "@/lib/errors/client";

export const DATA_URL_PREFIX = "data:";
const BASE64_DATA_MARKER = ";base64,";

export const decodeBase64DataUrl = (url: string) => {
  const payloadStart = url.indexOf(BASE64_DATA_MARKER);
  if (!url.startsWith(DATA_URL_PREFIX) || payloadStart === -1) {
    return Result.err(
      new ClientOperationError({
        action: "decode-chat-attachment",
        message: "Chat attachment is not a base64 data URL",
      }),
    );
  }

  const encoded = url.slice(payloadStart + BASE64_DATA_MARKER.length);
  return Result.try(() => atob(encoded))
    .map((binary) =>
      Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0),
    )
    .mapError(
      (cause) =>
        new ClientOperationError({
          action: "decode-chat-attachment",
          cause,
          message: "Chat attachment contains malformed base64 data",
        }),
    );
};

const USER_MESSAGE_FALLBACK_BLOCK_TAGS = Object.freeze([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "ul",
]);
const USER_MESSAGE_FALLBACK_INLINE_TAGS = Object.freeze([
  "a",
  "code",
  "del",
  "em",
  "entity-mention",
  "pasted-text",
  "s",
  "span",
  "strong",
  "u",
]);
const USER_MESSAGE_FALLBACK_TAGS = Object.freeze([
  ...USER_MESSAGE_FALLBACK_BLOCK_TAGS,
  ...USER_MESSAGE_FALLBACK_INLINE_TAGS,
  "br",
]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const getMentionTagAttr = (
  attrs: string,
  name: string,
): string | null => {
  const attrName = escapeRegExp(name);
  const match = new RegExp(
    `(?:^|\\s)${attrName}\\s*=\\s*(["'])(.*?)\\1`,
    "iu",
  ).exec(attrs);

  return match?.[2] ?? null;
};

const findTagEnd = (html: string, start: number): number => {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html.charAt(index);
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return index;
    }
  }
  return -1;
};

/**
 * Turns TipTap HTML into readable text without using DOMParser, so the same
 * result is safe during server rendering. Only known TipTap tags are removed,
 * so Markdown autolinks and comparison operators remain literal text.
 */
export const userMessageFallbackText = (html: string): string => {
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) {
      output += html.slice(cursor);
      break;
    }

    output += html.slice(cursor, tagStart);
    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd === -1) {
      output += html.slice(tagStart);
      break;
    }

    const rawTag = html.slice(tagStart + 1, tagEnd).trimStart();
    const closing = rawTag.startsWith("/");
    const nameStart = closing ? 1 : 0;
    let nameEnd = nameStart;
    while (/[\dA-Za-z-]/u.test(rawTag.charAt(nameEnd))) {
      nameEnd += 1;
    }
    const tagName = rawTag.slice(nameStart, nameEnd).toLowerCase();
    if (!USER_MESSAGE_FALLBACK_TAGS.some((name) => name === tagName)) {
      output += html.slice(tagStart, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }
    if (!closing && tagName === "entity-mention") {
      const label = getMentionTagAttr(rawTag, "data-label");
      if (label) {
        output += label;
      }
    }
    if (
      tagName === "br" ||
      (closing &&
        USER_MESSAGE_FALLBACK_BLOCK_TAGS.some(
          (blockTagName) => blockTagName === tagName,
        ))
    ) {
      output += "\n";
    }
    cursor = tagEnd + 1;
  }

  return output
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
};

/**
 * Keep the lazy Markdown renderer's first paint readable. The full renderer
 * replaces this fallback with semantic Markdown; until then, remove the most
 * visible source delimiters instead of flashing raw model syntax.
 */
const stripMarkdownLinkDestinations = (markdown: string): string => {
  let output = "";
  let candidate = "";
  let label = "";
  let state: "destination" | "label" | "text" = "text";

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown.charAt(index);
    const nextCharacter = markdown.charAt(index + 1);

    switch (state) {
      case "text": {
        if (character === "[" || (character === "!" && nextCharacter === "[")) {
          candidate = character === "[" ? "[" : "![";
          label = "";
          state = "label";
          if (character === "!") {
            index += 1;
          }
          break;
        }
        output += character;
        break;
      }
      case "label": {
        if (character === "]" && nextCharacter === "(") {
          candidate += "](";
          state = "destination";
          index += 1;
          break;
        }
        candidate += character;
        label += character;
        if (character === "]") {
          output += candidate;
          candidate = "";
          label = "";
          state = "text";
        }
        break;
      }
      case "destination": {
        candidate += character;
        if (character === ")") {
          output += label;
          candidate = "";
          label = "";
          state = "text";
        }
        break;
      }
      default: {
        state satisfies never;
        panic(`Unhandled state: ${String(state)}`);
      }
    }
  }

  return output + candidate;
};

export const assistantMessageFallbackText = (markdown: string): string =>
  stripMarkdownLinkDestinations(markdown)
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/\*\*|__/gu, "")
    .replace(/`+/gu, "");

type TurnBodyItem<TMessage extends PersistedChatMessage> = {
  message: TMessage;
  /** Position in the flat `messages` list, kept so anon-restoration lookups
   *  and retry targeting stay identical to the non-sticky layout. */
  index: number;
};

/**
 * A transcript segment. `user` turns start with a user message that becomes
 * the sticky header; `orphan` turns hold assistant/system messages that
 * precede any user message (e.g. a greeting, or the tail of an older turn
 * pulled in by pagination) and render without a sticky header.
 */
type MessageTurn<TMessage extends PersistedChatMessage> =
  | {
      type: "user";
      index: number;
      header: TMessage;
      body: TurnBodyItem<TMessage>[];
    }
  | { type: "orphan"; body: TurnBodyItem<TMessage>[] };

/**
 * Groups the flat message list into turns for the sticky layout: every user
 * message opens a new turn and the following non-user messages attach to it,
 * so each turn's height spans its whole answer. That height is what gives the
 * sticky header room to pin — a header can only stick within its own turn, so
 * the next turn's header pushes it out as it reaches the top.
 */
export const buildMessageTurns = <TMessage extends PersistedChatMessage>(
  messages: readonly TMessage[],
): MessageTurn<TMessage>[] => {
  const turns: MessageTurn<TMessage>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      turns.push({ type: "user", index, header: message, body: [] });
      continue;
    }
    const last = turns.at(-1);
    if (last) {
      last.body.push({ message, index });
      continue;
    }
    turns.push({ type: "orphan", body: [{ message, index }] });
  }
  return turns;
};

export const EMPTY_RESTORATION_PAIRS: readonly ChatAnonRestoration[] =
  Object.freeze([]);

/**
 * De-dupe placeholder -> original pairs across multiple parts in a
 * single assistant message so the rehype plugin builds one pattern
 * per stream.
 */
export const collectAnonRestorations = (
  message: PersistedChatMessage,
): readonly ChatAnonRestoration[] => {
  const seen = new Map<string, string>();
  const restorationPairs = message.metadata?.anonRestorations?.pairs;
  if (restorationPairs) {
    for (const pair of restorationPairs) {
      if (!seen.has(pair.placeholder)) {
        seen.set(pair.placeholder, pair.original);
      }
    }
  }
  return [...seen.entries()].map(([placeholder, original]) => ({
    placeholder,
    original,
  }));
};

/**
 * Resolve the restoration pairs that match what *this user message*
 * actually sent: walks forward from a user message's index and uses
 * the first assistant message's server-emitted metadata pairs, which
 * were produced by the same `PipelineContext` the request body
 * crossed. Returns an empty array while the assistant is still
 * streaming, if the turn was sent raw, or if the user message never
 * got a reply — all of these render the user message without pills,
 * matching the audit story (no anonymization -> no audit cue).
 *
 * INVARIANT the walk relies on, mirrored from `buildMessageTurns`:
 * every non-user message between one user message and the next
 * belongs to that user message's turn, and the backend persists at
 * most one assistant message per turn. A retry/regenerate does not
 * append a second assistant message alongside the first — the
 * backend's `replace-last-assistant` persistence plan (see
 * `apps/api/src/handlers/chat/persist-message.ts`) deletes the prior
 * assistant row in place, and the client's `chat.reload()` truncates
 * the live array back to the last user message before streaming a
 * replacement. So the walk MUST stop at the next user message: if it
 * kept going past it, a later turn's assistant reply (or a stray
 * user message left with no reply after a failed/queued send) could
 * get attached to an earlier, unrelated user message.
 */
export const getFollowingAssistantRestorations = (
  messages: readonly PersistedChatMessage[],
  userMessageIndex: number,
): readonly ChatAnonRestoration[] => {
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || candidate.role === "user") {
      break;
    }
    if (candidate.role === "assistant") {
      return collectAnonRestorations(candidate);
    }
  }
  return EMPTY_RESTORATION_PAIRS;
};
