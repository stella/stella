import type { ModelMessage, SystemPrompt, TextOptions } from "@tanstack/ai";

import { LOOP_RECOVERY_HEADING } from "@/api/handlers/chat/loop-detector";
import { isRecord } from "@/api/lib/type-guards";

// `chat.provider.prefix-stable`. Providers cache a prompt by its prefix:
// Anthropic up to a `cache_control` breakpoint, in the order tools, system,
// messages; OpenAI, Gemini and Bedrock implicitly, over the longest prefix a
// recent request shared. A turn issues several model requests (each tool
// iteration, an approval's continuation, the next user message), and each one
// is cheap only while it extends the one before it. Rewriting anything a
// previous request already sent (a tool reordered or re-described, a volatile
// value in the system prompt, an earlier message rebuilt differently from
// history) misses the cache silently: no error, only a bigger bill.
//
// A request is flattened into blocks in cache order, one per tool, system
// prompt and message, and every request of a thread must begin with every
// block of the one before it. The harness checks every conversation at the
// adapter seam (`chat-scripted-provider.ts`), and the provider wire replay
// checks the request bodies each provider SDK writes.
//
// What the flattening deliberately leaves out, because it is not part of the
// cached prefix:
// - `cache_control` markers. A marker says where a cached prefix ends; moving
//   it forward to the newest message is how an incremental conversation is
//   cached, so its position is not prefix content. Chat marks the ends of its
//   system prompt's static and organization layers, which never move, and
//   sets the request-level marker that lands on each request's last block
//   (`chat-request.ts`).
// - Model options, OpenAI's `prompt_cache_key` among them: a request's
//   settings, not its prompt. The key is derived from the stable part of the
//   system prompt (`buildChatPromptCacheKey`), so it holds whenever the
//   system blocks do.
//
// Sanctioned prefix moves, each of which misses the cache by design:
// - The loop-recovery section a run appends to the system prompt while the
//   model repeats itself (`createLoopRecoverySystemPrompt`), and its removal
//   on the next request. It is cut from the system prompt before comparing.
// - Regenerating an answer: the request replaces everything after the user
//   message it answers again (`replacesTail`).
// - A request made by a process that then died before storing what it had
//   sent (a tool's result, a partial answer): nothing kept it, so nothing can
//   extend it (`loseSince`).
// - In no conversation checked here: compaction and the history window (both
//   replace old history once a thread outgrows the model's context), editing
//   a message, a change of the context the user has open (the system prompt
//   describes it), and the day changing in the user's time zone (the system
//   prompt states the date).

/** The part of a model request a provider caches, as the engine hands it to
 *  the adapter. */
export type ModelRequestPrompt = {
  messages: TextOptions["messages"];
  systemPrompts: TextOptions["systemPrompts"] | undefined;
  tools: TextOptions["tools"] | undefined;
};

/** A request's prompt as its provider receives it: each section's entries in
 *  wire order. */
export type WirePromptSections = {
  messages: readonly unknown[];
  system: readonly unknown[];
  tools: readonly unknown[];
};

type PromptSegment = keyof WirePromptSections;

type PromptBlock = { index: number; segment: PromptSegment; text: string };

/** A request's cached prefix, in cache order. */
export type PromptBlocks = readonly PromptBlock[];

/** `value` as block text, without any `cache_control` marker, and with its
 *  keys sorted when their order never reaches the wire. */
const textOf = (value: unknown, { sortKeys }: { sortKeys: boolean }) => {
  const strip = (inner: unknown): unknown => {
    if (Array.isArray(inner)) {
      return inner.map(strip);
    }
    if (!isRecord(inner)) {
      return inner;
    }
    const keys = Object.keys(inner).filter(
      (key) => key !== "cache_control" && inner[key] !== undefined,
    );
    return Object.fromEntries(
      (sortKeys ? keys.toSorted() : keys).map((key) => [
        key,
        strip(inner[key]),
      ]),
    );
  };
  return JSON.stringify(strip(value));
};

const blocksOf = (
  sections: WirePromptSections,
  { sortMessageKeys }: { sortMessageKeys: boolean },
): PromptBlocks =>
  (["tools", "system", "messages"] as const).flatMap((segment) =>
    sections[segment].map((entry, index) => ({
      index,
      segment,
      text: textOf(entry, {
        sortKeys: segment === "messages" && sortMessageKeys,
      }),
    })),
  );

/**
 * Which fields of a message an adapter writes to the provider. The rest carry
 * the message through the stream and persistence (its id and time, AG-UI
 * metadata, the typed form of a structured answer whose text is `content`),
 * and differ between a message built live and the same one hydrated.
 */
const MESSAGE_FIELD_REACHES_PROVIDER = {
  content: true,
  createdAt: false,
  error: true,
  id: false,
  metadata: false,
  name: true,
  role: true,
  structuredOutput: false,
  thinking: true,
  toolCallId: true,
  toolCalls: true,
} as const satisfies Record<keyof ModelMessage, boolean>;

/** A field the message type does not declare is kept: nothing says an
 *  adapter ignores it. */
const reachesProvider = (key: string): boolean =>
  Object.entries(MESSAGE_FIELD_REACHES_PROVIDER).find(
    ([field]) => field === key,
  )?.[1] ?? true;

const LOOP_RECOVERY_SECTION = `\n\n${LOOP_RECOVERY_HEADING}\n`;

const withoutLoopRecovery = (prompt: SystemPrompt): SystemPrompt => {
  const content = typeof prompt === "string" ? prompt : prompt.content;
  const at = content.indexOf(LOOP_RECOVERY_SECTION);
  if (at === -1) {
    return prompt;
  }
  const base = content.slice(0, at);
  return typeof prompt === "string" ? base : { ...prompt, content: base };
};

/**
 * The prompt of a call the engine hands an adapter. A message's keys are
 * sorted: the engine builds a message live and again from stored history,
 * and an adapter writes each field by name, so their order never reaches the
 * wire. A tool's schema and a system prompt pass through as they are.
 */
export const promptBlocksOf = ({
  messages,
  systemPrompts = [],
  tools = [],
}: ModelRequestPrompt): PromptBlocks =>
  blocksOf(
    {
      messages: messages.map((message) =>
        Object.fromEntries(
          Object.entries(message).filter(([key]) => reachesProvider(key)),
        ),
      ),
      system: systemPrompts.map(withoutLoopRecovery),
      // A tool's handler and flags never reach the wire.
      tools: tools.map(
        (tool): Record<"description" | "inputSchema" | "name", unknown> => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
        }),
      ),
    },
    { sortMessageKeys: true },
  );

/** The prompt of a request body an SDK sent, byte for byte but for
 *  `cache_control` markers. */
export const wirePromptBlocksOf = (sections: WirePromptSections) =>
  blocksOf(sections, { sortMessageKeys: false });

/** Characters of context a finding shows on each side of a difference. */
const CONTEXT_CHARS = 120;

/** Both texts around the first character where they differ. */
const divergenceOf = (previous: string, next: string) => {
  let offset = 0;
  while (
    offset < previous.length &&
    offset < next.length &&
    previous[offset] === next[offset]
  ) {
    offset += 1;
  }
  const start = Math.max(0, offset - CONTEXT_CHARS);
  const end = offset + CONTEXT_CHARS;
  return {
    next: next.slice(start, end),
    offset,
    previous: previous.slice(start, end),
  };
};

/**
 * Where `next` stops extending `previous`: the first block of `previous` it
 * does not repeat in place, or null when it begins with all of them.
 */
const prefixBreakOf = (previous: PromptBlocks, next: PromptBlocks) => {
  const at = previous.findIndex((block, index) => {
    const repeated = next.at(index);
    return (
      repeated === undefined ||
      repeated.segment !== block.segment ||
      repeated.index !== block.index ||
      repeated.text !== block.text
    );
  });
  const moved = previous[at];
  if (moved === undefined) {
    return null;
  }
  const replacement = next[at];
  return {
    block: { index: moved.index, segment: moved.segment },
    ...(replacement === undefined
      ? { next: null, previous: moved.text.slice(0, CONTEXT_CHARS) }
      : {
          nextBlock: {
            index: replacement.index,
            segment: replacement.segment,
          },
          ...divergenceOf(moved.text, replacement.text),
        }),
  };
};

const isUserMessageBlock = ({ segment, text }: PromptBlock): boolean => {
  if (segment !== "messages") {
    return false;
  }
  const message: unknown = JSON.parse(text);
  return isRecord(message) && message["role"] === "user";
};

/** `blocks` through its last user message: what a regenerated answer keeps. */
const upToLastUserMessage = (blocks: PromptBlocks): PromptBlocks =>
  blocks.slice(0, blocks.findLastIndex(isUserMessageBlock) + 1);

/**
 * The model calls of one thread, in order, and where each stopped extending
 * the one before it.
 */
export const createPromptPrefixLedger = () => {
  let calls = 0;
  /** The calls a later call must extend, oldest first. */
  const kept: { blocks: PromptBlocks; call: number; replacesTail: boolean }[] =
    [];
  /** How many of `kept` have been compared with the call before them. */
  let compared = 0;
  let nextReplacesTail = false;
  const findings: unknown[] = [];

  const compare = () => {
    for (let index = Math.max(compared, 1); index < kept.length; index += 1) {
      const previous = kept[index - 1];
      const next = kept[index];
      if (previous === undefined || next === undefined) {
        continue;
      }
      const found = prefixBreakOf(
        next.replacesTail
          ? upToLastUserMessage(previous.blocks)
          : previous.blocks,
        next.blocks,
      );
      if (found !== null) {
        findings.push({ call: next.call, extends: previous.call, ...found });
      }
    }
    compared = kept.length;
  };

  return {
    /** How many calls have been recorded, lost ones included. */
    calls: (): number => calls,
    /** Records a model call's prompt, flattened as it was sent. */
    record: (blocks: PromptBlocks): void => {
      kept.push({ blocks, call: calls, replacesTail: nextReplacesTail });
      calls += 1;
      nextReplacesTail = false;
    },
    /** The next call regenerates an answer: it extends the call before it
     *  only up to that call's last user message. */
    replacesTail: (): void => {
      nextReplacesTail = true;
    },
    /** Where the next recorded call will sit, for `loseSince`. */
    mark: (): number => kept.length,
    /**
     * The calls recorded since `mark` came from a process that died before
     * storing what they were sent, so no later call can extend them: later
     * calls extend the one before `mark`. Each lost call is still compared
     * with the one before it.
     */
    loseSince: (mark: number): void => {
      compare();
      kept.splice(mark);
      compared = kept.length;
    },
    /** Every break found since the last call, cleared on read. */
    takeBreaks: (): unknown[] => {
      compare();
      return findings.splice(0);
    },
  };
};

export type PromptPrefixLedger = ReturnType<typeof createPromptPrefixLedger>;
