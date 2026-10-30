import { Result } from "better-result";

import { iterateBodyWithIdleDeadline } from "@stll/fetch";

type SSEEvent = { event: string; data: string };

const parseSSEBlock = (block: string): SSEEvent | null => {
  if (block.length === 0) {
    return null;
  }
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  return { event, data: dataLines.join("\n") };
};

const parseSSE = (raw: string): SSEEvent[] => {
  const events: SSEEvent[] = [];
  for (const block of raw.split("\n\n")) {
    const parsed = parseSSEBlock(block);
    if (parsed !== null) {
      events.push(parsed);
    }
  }
  return events;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJson = (data: string): unknown => JSON.parse(data);

const readStringField = (data: string, field: string): string | null => {
  const parsed = Result.try(() => parseJson(data));
  if (Result.isError(parsed) || !isRecord(parsed.value)) {
    return null;
  }
  const value = parsed.value[field];
  return typeof value === "string" ? value : null;
};

type StreamHandlers = {
  onToken: (text: string) => void;
  onStreamError: (message: string) => void;
};

export const consumeStream = async (
  response: Response,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of iterateBodyWithIdleDeadline(response, {
    idleMs: 15_000,
    signal,
  })) {
    buffer += decoder.decode(chunk, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) {
      continue;
    }
    const ready = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseSSE(ready)) {
      if (event.event === "token") {
        const text = readStringField(event.data, "text");
        if (text !== null && text.length > 0) {
          handlers.onToken(text);
        }
      } else if (event.event === "error") {
        handlers.onStreamError(
          readStringField(event.data, "message") ?? "stream error",
        );
        return;
      } else if (event.event === "done") {
        return;
      }
    }
  }
};
