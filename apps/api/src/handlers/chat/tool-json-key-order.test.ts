import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  sortToolJsonKeys,
  toolArgumentsWithSortedKeys,
  withSortedJsonKeys,
} from "@/api/handlers/chat/tool-json-key-order";
import { isRecord } from "@/api/lib/type-guards";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";

/** `value` with every object's keys in reverse order. */
const withReversedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withReversedKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toReversed()
      .map((key) => [key, withReversedKeys(value[key])]),
  );
};

describe("the JSON keys of tool calls and results", () => {
  test("serialize alike whatever order the value was built in", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const built = JSON.stringify(value);
        const stored = JSON.stringify(withReversedKeys(value));
        const sorted = withSortedJsonKeys(built);
        expect(withSortedJsonKeys(stored)).toBe(sorted);
        expect(JSON.parse(sorted)).toEqual(JSON.parse(built));
        expect(withSortedJsonKeys(sorted)).toBe(sorted);
      }),
      propertyConfig(),
    );
  });

  test("serialize alike once the stored value has lost its key order", () => {
    // The order a tool built, and the order a jsonb column gives back.
    const built = '{"id":"t1","name":"NDA","fieldCount":0,"tags":null}';
    const stored = '{"id":"t1","name":"NDA","tags":null,"fieldCount":0}';
    expect(stored).not.toBe(built);
    expect(withSortedJsonKeys(stored)).toBe(withSortedJsonKeys(built));
  });

  test("leave text that is not JSON as JSON.stringify writes it alone", () => {
    for (const text of ["Deleted the draft.", '{ "b": 1, "a": 2 }', "1.0"]) {
      expect(withSortedJsonKeys(text)).toBe(text);
    }
  });

  test("of a call's arguments reach the model alike however the model spaced them", () => {
    // The model's spelling live, and the stored input written back on the
    // thread's next request.
    const spoken = '{ "query": "NDA", "limit": 5 }';
    const stored = JSON.stringify(JSON.parse(spoken));
    expect(stored).not.toBe(spoken);
    const argumentsSent = (text: string) => {
      const messages: ModelMessage[] = [
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              function: { arguments: text, name: "search_templates" },
              id: "call-1",
              type: "function",
            },
          ],
        },
      ];
      return (sortToolJsonKeys(messages) ?? messages)[0]?.toolCalls?.[0]
        ?.function.arguments;
    };
    const live = argumentsSent(spoken);
    const later = argumentsSent(stored);
    expect(
      violationsOf(
        CHAT_ORACLE.providerPrefixStable,
        live === later ? [] : [{ later, live }],
      ),
    ).toEqual([]);
    // Arguments cut off mid-JSON are sent as they are.
    expect(toolArgumentsWithSortedKeys('{"query":"nd')).toBe('{"query":"nd');
  });

  test("are sorted in tool calls and tool results only", () => {
    const unsorted = '{"b":1,"a":2}';
    const call = {
      function: { arguments: unsorted, name: "list_templates" },
      id: "call-1",
      type: "function" as const,
    };
    const messages: ModelMessage[] = [
      { content: unsorted, role: "user" },
      { content: unsorted, role: "assistant", toolCalls: [call] },
      { content: unsorted, role: "tool", toolCallId: "call-1" },
    ];
    const sorted = sortToolJsonKeys(messages);
    expect(sorted).toEqual([
      { content: unsorted, role: "user" },
      {
        content: unsorted,
        role: "assistant",
        toolCalls: [
          {
            ...call,
            function: { ...call.function, arguments: '{"a":2,"b":1}' },
          },
        ],
      },
      { content: '{"a":2,"b":1}', role: "tool", toolCallId: "call-1" },
    ]);
    expect(sortToolJsonKeys(sorted ?? [])).toBe(undefined);
  });
});
