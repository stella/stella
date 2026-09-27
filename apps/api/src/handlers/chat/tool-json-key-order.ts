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
 * `text` with every object's keys sorted, when it is JSON as `JSON.stringify`
 * writes it. Any other text (prose, JSON spelled another way) is returned as
 * it is: rewriting it could change more than key order.
 */
export const withSortedJsonKeys = (text: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (JSON.stringify(value) !== text) {
    return text;
  }
  return JSON.stringify(withSortedKeys(value));
};

const withSortedToolJson = (message: ModelMessage): ModelMessage => {
  if (message.role === "tool" && typeof message.content === "string") {
    const content = withSortedJsonKeys(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (message.role !== "assistant" || message.toolCalls === undefined) {
    return message;
  }
  const toolCalls = message.toolCalls.map((call) => {
    const args = withSortedJsonKeys(call.function.arguments);
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
