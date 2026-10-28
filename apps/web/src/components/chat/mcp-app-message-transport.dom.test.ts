import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PostMessageTransport } from "@mcp-ui/client";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });

afterAll(async () => {
  await unregisterDomEnvironment();
});

const LIMIT_ERROR = "MCP App message exceeds host input limits";
const STRING_LIMIT = 1_048_576;
const TOTAL_LIMIT = 4_194_304;

const deliver = async (data: unknown) => {
  const transport = new PostMessageTransport(window, window);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transport exposes callback properties, not EventTarget listeners.
  transport.onmessage = (message) => {
    messages.push(message);
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transport exposes callback properties, not EventTarget listeners.
  transport.onerror = (error) => {
    errors.push(error);
  };
  await transport.start();
  window.dispatchEvent(new MessageEvent("message", { source: window, data }));
  await transport.close();
  return { messages, errors: errors.map(({ message }) => message) };
};

const uiMessage = (content: unknown) => ({
  jsonrpc: "2.0",
  method: "ui/message",
  params: { content },
});

const textBlocks = (count: number, length: number) =>
  Array.from({ length: count }, () => ({
    type: "text",
    text: "x".repeat(length),
  }));

test("rejects oversized sandbox messages before protocol validation", async () => {
  expect(
    await deliver(
      uiMessage(
        Array.from({ length: 4097 }, () => ({ type: "text", text: "x" })),
      ),
    ),
  ).toEqual({ messages: [], errors: [LIMIT_ERROR] });
});

test("bounds the combined text of a message, not only each string", async () => {
  // Each string is within its own limit; together they exceed the message total.
  expect(await deliver(uiMessage(textBlocks(5, STRING_LIMIT)))).toEqual({
    messages: [],
    errors: [LIMIT_ERROR],
  });
  // Object keys carry no per-string limit, so only the total bounds them.
  expect(
    await deliver({
      jsonrpc: "2.0",
      method: "ui/message",
      params: { ["k".repeat(TOTAL_LIMIT + 1)]: true },
    }),
  ).toEqual({ messages: [], errors: [LIMIT_ERROR] });

  const withinTotal = await deliver(uiMessage(textBlocks(3, STRING_LIMIT)));
  expect(withinTotal.errors).not.toContain(LIMIT_ERROR);
});

test.each([
  ["an ArrayBuffer", (buffer: ArrayBuffer) => buffer],
  [
    "a one-byte typed array",
    (buffer: ArrayBuffer) => new Uint8Array(buffer, 0, 1),
  ],
  ["a one-byte DataView", (buffer: ArrayBuffer) => new DataView(buffer, 0, 1)],
])("counts the whole buffer behind %s", async (_name, view) => {
  const payload = view(new ArrayBuffer(TOTAL_LIMIT + 1));
  expect(
    await deliver(uiMessage([{ type: "text", text: "x", payload }])),
  ).toEqual({ messages: [], errors: [LIMIT_ERROR] });
});

class Payload {
  text = "x";
}

// A message holds only JSON-shaped values and binary buffers; any other kind
// of value is refused whatever its size.
test.each([
  ["an oversized Map", () => new Map([["text", "x".repeat(TOTAL_LIMIT + 1)]])],
  ["an oversized Set", () => new Set(["x".repeat(TOTAL_LIMIT + 1)])],
  ["an oversized Blob", () => new Blob(["x".repeat(TOTAL_LIMIT + 1)])],
  ["a small Map", () => new Map([["text", "x"]])],
  ["a small Set", () => new Set(["x"])],
  ["a Date", () => new Date(0)],
  ["a class instance", () => new Payload()],
])("refuses %s", async (_name, value) => {
  expect(
    await deliver(uiMessage([{ type: "text", text: "x", payload: value() }])),
  ).toEqual({ messages: [], errors: [LIMIT_ERROR] });
});

// Structured clone keeps shared references, and consumers read each
// occurrence, so every occurrence counts toward the budget.
test("counts every occurrence of a shared value", async () => {
  const block = { type: "text", text: "x".repeat(STRING_LIMIT) };
  expect(
    await deliver(uiMessage(Array.from({ length: 4096 }, () => block))),
  ).toEqual({
    messages: [],
    errors: [LIMIT_ERROR],
  });

  const threeMegabytes = {
    type: "text",
    text: "x",
    parts: ["a", "b", "c"].map(() => "x".repeat(STRING_LIMIT)),
  };
  const once = await deliver(uiMessage([threeMegabytes]));
  expect(once.errors).not.toContain(LIMIT_ERROR);
  expect(await deliver(uiMessage([threeMegabytes, threeMegabytes]))).toEqual({
    messages: [],
    errors: [LIMIT_ERROR],
  });

  const buffer = new ArrayBuffer(3 * STRING_LIMIT);
  expect(
    await deliver(
      uiMessage([{ type: "text", text: "x", payload: [buffer, buffer] }]),
    ),
  ).toEqual({ messages: [], errors: [LIMIT_ERROR] });

  const small = { type: "text", text: "x" };
  const twice = await deliver(uiMessage([small, small]));
  expect(twice.errors).not.toContain(LIMIT_ERROR);
});

test.each([
  [
    "an object that contains itself",
    () => {
      const block: Record<string, unknown> = { type: "text", text: "x" };
      block["self"] = block;
      return [block];
    },
  ],
  [
    "an array that contains itself",
    () => {
      const content: unknown[] = [{ type: "text", text: "x" }];
      content.push(content);
      return content;
    },
  ],
])("refuses %s", async (_name, content) => {
  expect(await deliver(uiMessage(content()))).toEqual({
    messages: [],
    errors: [LIMIT_ERROR],
  });
});

test("accepts a null-prototype object", async () => {
  const block = Object.assign(Object.create(null), {
    type: "text",
    text: "x",
  });
  const delivered = await deliver(uiMessage([block]));
  expect(delivered.errors).not.toContain(LIMIT_ERROR);
});

test("a small binary payload stays within the budget", async () => {
  const small = await deliver(
    uiMessage([{ type: "text", text: "x", payload: new Uint8Array(16) }]),
  );
  expect(small.errors).not.toContain(LIMIT_ERROR);
});
