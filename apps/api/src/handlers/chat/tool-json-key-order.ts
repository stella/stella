import type { ModelMessage } from "@tanstack/ai";

import { isRecord } from "@/api/lib/type-guards";

// A tool call's arguments and a tool's result reach the model as JSON text.
// Live, that text keeps the order the model wrote the arguments in and the
// order the tool built its result in. On every later request of the thread
// both are written again from the input and output the thread stored, and the
// jsonb column that holds them keeps no key order. The texts then differ, and
// the provider's prompt cache misses from the first of them on. Both are
// therefore sent with their keys in one fixed order, which the live text and
// the stored value reach alike.

const withSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, withSortedKeys(value[key])]),
  );
};

/**
 * `text` as JSON with every object's keys sorted, or undefined when it is not
 * JSON.
 */
const sortedJsonOf = (
  text: string,
): { json: string; value: unknown } | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return { json: JSON.stringify(withSortedKeys(value)), value };
};

/**
 * `text` with every object's keys sorted, when it is JSON as `JSON.stringify`
 * writes it. Any other text (prose, JSON spelled another way) is returned as
 * it is: a tool result is stored as the text it was, and rewriting that could
 * change more than key order.
 */
export const withSortedJsonKeys = (text: string): string => {
  const sorted = sortedJsonOf(text);
  return sorted === undefined || JSON.stringify(sorted.value) !== text
    ? text
    : sorted.json;
};

/**
 * A tool call's arguments with every object's keys sorted and no whitespace,
 * when they are JSON at all. The thread stores the parsed arguments and writes
 * them again with `JSON.stringify`, so the model's own spelling does not
 * survive the first request either way.
 */
export const toolArgumentsWithSortedKeys = (text: string): string =>
  sortedJsonOf(text)?.json ?? text;

const withSortedToolJson = (message: ModelMessage): ModelMessage => {
  if (message.role === "tool" && typeof message.content === "string") {
    const content = withSortedJsonKeys(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (message.role !== "assistant" || message.toolCalls === undefined) {
    return message;
  }
  const toolCalls = message.toolCalls.map((call) => {
    const args = toolArgumentsWithSortedKeys(call.function.arguments);
    return args === call.function.arguments
      ? call
      : { ...call, function: { ...call.function, arguments: args } };
  });
  return toolCalls.every((call, index) => call === message.toolCalls?.[index])
    ? message
    : { ...message, toolCalls };
};

/**
 * `messages` with the JSON keys of every tool call's arguments and every tool
 * result sorted, or undefined when none needed it. Reordering keys adds no
 * text, so the result stays as guarded as `messages` was.
 */
export const sortToolJsonKeys = (
  messages: readonly ModelMessage[],
): ModelMessage[] | undefined => {
  const sorted = messages.map(withSortedToolJson);
  return sorted.some((message, index) => message !== messages[index])
    ? sorted
    : undefined;
};
