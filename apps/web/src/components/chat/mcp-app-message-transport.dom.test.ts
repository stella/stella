import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PostMessageTransport } from "@mcp-ui/client";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("rejects oversized sandbox messages before protocol validation", async () => {
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

  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: {
        jsonrpc: "2.0",
        method: "ui/message",
        params: {
          content: Array.from({ length: 4097 }, () => ({
            type: "text",
            text: "x",
          })),
        },
      },
    }),
  );

  expect(messages).toEqual([]);
  expect(errors.map(({ message }) => message)).toEqual([
    "MCP App message exceeds host input limits",
  ]);

  await transport.close();
});
