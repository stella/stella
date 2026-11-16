import { EventType } from "@tanstack/ai";
import net from "node:net";
import * as v from "valibot";

import { waitFor } from "@stll/test-kit";

import {
  SIDECAR_PROTOCOL,
  type sidecarHostMessageSchema,
  type SidecarMessage,
  sidecarMessageSchema,
} from "../src/sidecar/protocol";

/**
 * What the local browser end-to-end tests put around a holder: a stand-in
 * for stella's API that records every request it receives, and the desktop
 * connected to the holder, approving every step it is asked about. Both
 * are where page content must never arrive.
 */

type Cleanup = () => Promise<void> | void;

/** The stand-in for stella's API: records every request it receives. */
export const startApiStandIn = (cleanup: (step: Cleanup) => void) => {
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      received.push(
        [
          request.method,
          request.url,
          JSON.stringify([...request.headers.entries()]),
          body,
        ].join("\n"),
      );
      const message: unknown = body === "" ? null : JSON.parse(body);
      const id =
        typeof message === "object" && message !== null
          ? Reflect.get(message, "id")
          : undefined;
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }
      const method = Reflect.get(message ?? {}, "method");
      return Response.json({
        id,
        jsonrpc: "2.0",
        result:
          method === "initialize"
            ? {
                capabilities: { tools: {} },
                protocolVersion: "2025-06-18",
                serverInfo: { name: "stella", version: "0" },
              }
            : {
                content: [
                  { type: "text", text: JSON.stringify({ results: [] }) },
                ],
              },
      });
    },
  });
  cleanup(async () => {
    await server.stop(true);
  });
  return { origin: `http://127.0.0.1:${String(server.port)}`, received };
};

type Desktop = { lines: string[]; messages: SidecarMessage[] };

/** A message as the schema reads it, so a field it gains fails the build here. */
export type HostMessage = v.InferInput<typeof sidecarHostMessageSchema>;

/** Connect to the holder and authenticate as the desktop. */
export const connectDesktop = async (
  {
    apiOrigin,
    endpoint,
    secret,
  }: { apiOrigin: string; endpoint: string; secret: string },
  cleanup: (step: Cleanup) => void,
): Promise<Desktop & { send: (message: HostMessage) => void }> => {
  const socket = net.createConnection({ path: endpoint });
  cleanup(() => {
    socket.destroy();
  });
  const desktop: Desktop = { lines: [], messages: [] };
  const decoder = new TextDecoder();
  let buffer = "";
  socket.on("data", (bytes: Uint8Array) => {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      desktop.lines.push(line);
      const message = v.parse(sidecarMessageSchema, JSON.parse(line));
      desktop.messages.push(message);
      // The member allows every step they are asked about.
      if (message.type === "run.approval_request") {
        send({
          type: "run.approval",
          runId: message.runId,
          requestId: message.requestId,
          decision: "approve",
        });
      }
    }
  });
  const send = (message: HostMessage) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };
  send({
    type: "hello",
    protocol: SIDECAR_PROTOCOL,
    secret,
    appVersion: "1.4.0",
    apiOrigin,
    resume: [],
  });
  await waitFor(
    () =>
      desktop.messages.some(({ type }) => type === "hello") ? true : undefined,
    { timeoutMs: 20_000, description: "the holder's hello" },
  );
  return { ...desktop, send };
};

/** Each tool call as the run reported it: its name and the input it kept. */
export const toolCalls = (chunks: readonly Record<string, unknown>[]) => {
  const args = new Map(
    chunks.flatMap((chunk) =>
      chunk["type"] === EventType.TOOL_CALL_ARGS &&
      typeof chunk["toolCallId"] === "string" &&
      typeof chunk["delta"] === "string"
        ? [[chunk["toolCallId"], chunk["delta"]] as const]
        : [],
    ),
  );
  return chunks.flatMap((chunk) => {
    if (
      chunk["type"] !== EventType.TOOL_CALL_START ||
      typeof chunk["toolCallId"] !== "string"
    ) {
      return [];
    }
    const input = args.get(chunk["toolCallId"]);
    return [
      {
        id: chunk["toolCallId"],
        name: chunk["toolCallName"],
        input: input === undefined ? undefined : JSON.parse(input),
      },
    ];
  });
};

/** Each tool result the run reported, as the chat keeps it. */
export const toolResults = (chunks: readonly Record<string, unknown>[]) =>
  chunks.flatMap((chunk) =>
    chunk["type"] === EventType.TOOL_CALL_RESULT &&
    typeof chunk["content"] === "string"
      ? [JSON.parse(chunk["content"])]
      : [],
  );
