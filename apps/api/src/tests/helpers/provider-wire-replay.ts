import { panic, TaggedError } from "better-result";

import type {
  AwsEventStreamMessage,
  ProviderWireCassette,
  ProviderWireExchange,
} from "@/api/tests/helpers/provider-wire-cassette";

/** A request the replay would not answer. */
class ProviderWireRefusal extends TaggedError("ProviderWireRefusal")<{
  message: string;
}> {}

// A fetch-level provider: every request an SDK makes goes through
// `globalThis.fetch`, so replacing it serves cassettes to the real adapters
// with nothing mocked above the socket. The replacement is installed once
// and serves whatever is queued now, because some SDK clients keep the fetch
// they were constructed with. Nothing reaches the network: a request to any
// other host, or with no exchange queued, is refused and recorded.

/** Hosts the supported provider APIs are served from. */
const PROVIDER_HOST =
  /^(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|openrouter\.ai|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cassette\.invalid)?)$/u;

/** Bodies go out in slices this long, so parsers see events split across
 *  reads (and multi-byte characters split across slices). */
const SLICE_BYTES = 61;

// --- AWS event stream framing ---------------------------------------------

const STRING_HEADER_TYPE = 7;
const PRELUDE_BYTES = 12;
const CRC_BYTES = 4;

const crc32 = (bytes: Uint8Array): number => Bun.hash.crc32(bytes);

const encodeHeaders = (headers: Record<string, string>): Uint8Array => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const header = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
    const view = new DataView(header.buffer);
    header[0] = nameBytes.length;
    header.set(nameBytes, 1);
    header[1 + nameBytes.length] = STRING_HEADER_TYPE;
    view.setUint16(2 + nameBytes.length, valueBytes.length);
    header.set(valueBytes, 4 + nameBytes.length);
    parts.push(header);
  }
  return concatBytes(parts);
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

/** One `application/vnd.amazon.eventstream` frame. */
export const encodeAwsEventStreamMessage = ({
  headers,
  payload,
}: AwsEventStreamMessage): Uint8Array => {
  const headerBytes = encodeHeaders(headers);
  const payloadBytes = new TextEncoder().encode(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  const total =
    PRELUDE_BYTES + headerBytes.length + payloadBytes.length + CRC_BYTES;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, PRELUDE_BYTES);
  frame.set(payloadBytes, PRELUDE_BYTES + headerBytes.length);
  view.setUint32(
    total - CRC_BYTES,
    crc32(frame.subarray(0, total - CRC_BYTES)),
  );
  return frame;
};

/** The frames of an event stream body, for the recorder. */
export const decodeAwsEventStream = (
  bytes: Uint8Array,
): AwsEventStreamMessage[] => {
  const decoder = new TextDecoder();
  const messages: AwsEventStreamMessage[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const total = view.getUint32(0);
    const headersLength = view.getUint32(4);
    const headers: Record<string, string> = {};
    let cursor = PRELUDE_BYTES;
    while (cursor < PRELUDE_BYTES + headersLength) {
      const nameLength = view.getUint8(cursor);
      const name = decoder.decode(
        bytes.subarray(offset + cursor + 1, offset + cursor + 1 + nameLength),
      );
      const type = view.getUint8(cursor + 1 + nameLength);
      if (type !== STRING_HEADER_TYPE) {
        return panic(`Unsupported event stream header type ${String(type)}`);
      }
      const valueLength = view.getUint16(cursor + 2 + nameLength);
      const valueStart = offset + cursor + 4 + nameLength;
      headers[name] = decoder.decode(
        bytes.subarray(valueStart, valueStart + valueLength),
      );
      cursor += 4 + nameLength + valueLength;
    }
    const payloadText = decoder.decode(
      bytes.subarray(
        offset + PRELUDE_BYTES + headersLength,
        offset + total - CRC_BYTES,
      ),
    );
    let payload: AwsEventStreamMessage["payload"] = payloadText;
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        payload = Object.fromEntries(Object.entries(parsed));
      }
    } catch {
      // Not JSON: kept as the literal payload.
    }
    messages.push({ headers, payload });
    offset += total;
  }
  return messages;
};

export const bodyBytesOf = (
  body: ProviderWireExchange["response"]["body"],
): Uint8Array =>
  body.encoding === "text"
    ? new TextEncoder().encode(body.text)
    : concatBytes(body.messages.map(encodeAwsEventStreamMessage));

// --- Replay -----------------------------------------------------------------

const abortError = () =>
  new DOMException("The operation was aborted.", "AbortError");

type ServeOptions = {
  /** Holds the first exchange's body open after this many bytes until the
   *  request is aborted, the way a model that stops talking does. */
  holdAfterBytes?: number | undefined;
};

/** A request the replay answered or refused. */
export type ReplayedRequest = {
  exchange: number | "side" | null;
  model: string | null;
  path: string;
  url: string;
};

export type ProviderWireReplayFindings = {
  /** Requests no queued exchange answered. */
  unexpected: string[];
  /** Exchanges no request consumed. */
  unconsumed: string[];
};

/** The model a provider request names: in the JSON body, or in the path
 *  (Gemini, Bedrock). */
const requestModelOf = (url: URL, bodyText: string): string | null => {
  const pathModel = /\/models?\/([^/:]+)/u.exec(url.pathname)?.[1];
  if (pathModel !== undefined) {
    return decodeURIComponent(pathModel);
  }
  try {
    const body: unknown = JSON.parse(bodyText);
    const model: unknown =
      typeof body === "object" && body !== null
        ? Reflect.get(body, "model")
        : undefined;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
};

const readRequest = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
) => {
  const request =
    input instanceof Request ? input : new Request(input.toString(), init);
  const url = new URL(request.url);
  const bodyText =
    init?.body !== undefined && init.body !== null
      ? await new Response(init.body).text()
      : await request.clone().text();
  const signal = init?.signal ?? request.signal;
  return { bodyText, method: init?.method ?? request.method, signal, url };
};

/** Path and query as a cassette stores them: no credential parameters. */
export const cassetteRequestPath = (url: URL): string => {
  const copy = new URL(url.toString());
  copy.searchParams.delete("key");
  return `${copy.pathname}${copy.search}`;
};

const responseFor = (
  exchange: ProviderWireExchange,
  signal: AbortSignal | null,
  holdAfterBytes: number | undefined,
): Response => {
  const bytes = bodyBytesOf(exchange.response.body);
  const limit = holdAfterBytes ?? bytes.length;
  let offset = 0;
  let onAbort: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        try {
          controller.error(abortError());
        } catch {
          // Already closed.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      await Promise.resolve();
      if (signal?.aborted === true) {
        controller.error(abortError());
        return;
      }
      if (offset >= limit && limit < bytes.length) {
        // Quiet until the request is aborted; the abort listener errors
        // the stream.
        await new Promise<void>((resolve) => {
          if (signal === null || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        return;
      }
      if (offset >= bytes.length) {
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
        if (exchange.response.ending === "reset") {
          controller.error(
            new TypeError("The socket connection was closed unexpectedly."),
          );
          return;
        }
        controller.close();
        return;
      }
      const end = Math.min(offset + SLICE_BYTES, limit);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(body, {
    headers: exchange.response.headers,
    status: exchange.response.status,
  });
};

/**
 * Installs the replay as `globalThis.fetch` until `restore`. Queue a
 * cassette with `serve`, run the adapter, then read `takeFindings`.
 */
export const installProviderWireReplay = () => {
  const originalFetch = globalThis.fetch;
  let queue: { exchange: ProviderWireExchange; served: number }[] = [];
  let cursor = 0;
  let model: string | null = null;
  let sideAnswer: ProviderWireExchange | undefined;
  let options: ServeOptions = {};
  let unexpected: string[] = [];
  let requests: ReplayedRequest[] = [];

  const replayFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const { bodyText, method, signal, url } = await readRequest(input, init);
    const path = cassetteRequestPath(url);
    const requestModel = requestModelOf(url, bodyText);
    const refuse = (reason: string): never => {
      unexpected.push(`${method} ${url.host}${path}: ${reason}`);
      requests.push({
        exchange: null,
        model: requestModel,
        path,
        url: url.toString(),
      });
      // A rejected fetch, which every SDK reads as a connection failure.
      throw new ProviderWireRefusal({
        message: `Provider wire replay refused the request: ${reason}`,
      });
    };
    if (!PROVIDER_HOST.test(url.hostname)) {
      return refuse(
        "not a provider host; the replay never reaches the network",
      );
    }
    if (signal?.aborted === true) {
      throw abortError();
    }
    if (
      sideAnswer !== undefined &&
      model !== null &&
      requestModel !== null &&
      requestModel !== model
    ) {
      requests.push({
        exchange: "side",
        model: requestModel,
        path,
        url: url.toString(),
      });
      return responseFor(sideAnswer, signal, undefined);
    }
    // A repeated exchange answers every retry until a request asks for
    // something else.
    const previous = queue[cursor - 1];
    const current =
      previous?.exchange.repeat === true &&
      previous.exchange.request.path === path
        ? { entry: previous, index: cursor - 1 }
        : { entry: queue[cursor], index: cursor };
    if (current.entry === undefined) {
      return refuse("no exchange left to answer it");
    }
    if (current.entry.exchange.request.path !== path) {
      return refuse(`expected ${current.entry.exchange.request.path}`);
    }
    if (method !== current.entry.exchange.request.method) {
      return refuse(`expected ${current.entry.exchange.request.method}`);
    }
    if (model !== null && requestModel !== null && requestModel !== model) {
      return refuse(`expected model ${model}, got ${requestModel}`);
    }
    if (current.index === cursor) {
      cursor += 1;
    }
    current.entry.served += 1;
    requests.push({
      exchange: current.index,
      model: requestModel,
      path,
      url: url.toString(),
    });
    return responseFor(
      current.entry.exchange,
      signal,
      current.index === 0 && current.entry.served === 1
        ? options.holdAfterBytes
        : undefined,
    );
  };

  globalThis.fetch = Object.assign(replayFetch, {
    preconnect: () => undefined,
  });

  return {
    /** Queues `cassette`'s exchanges, replacing anything still queued. */
    serve: (
      cassette: Pick<ProviderWireCassette, "exchanges" | "model">,
      serveOptions: ServeOptions = {},
    ) => {
      queue = cassette.exchanges.map((exchange) => ({ exchange, served: 0 }));
      cursor = 0;
      model = cassette.model;
      options = serveOptions;
    },
    /** Appends exchanges to what is queued, for a conversation's next
     *  model calls. */
    enqueue: (cassette: Pick<ProviderWireCassette, "exchanges" | "model">) => {
      queue.push(
        ...cassette.exchanges.map((exchange) => ({ exchange, served: 0 })),
      );
      model = cassette.model;
    },
    /** Answers requests for any other model (a thread title, a summary)
     *  with `exchange`, outside the queue. */
    answerSideCalls: (exchange: ProviderWireExchange | undefined) => {
      sideAnswer = exchange;
    },
    /** Every request since the last `takeFindings`. */
    requests: (): readonly ReplayedRequest[] => requests,
    /** Findings since the last call, cleared on read. */
    takeFindings: (): ProviderWireReplayFindings => {
      const findings = {
        unconsumed: queue
          .slice(cursor)
          .map(
            ({ exchange }) =>
              `${exchange.request.method} ${exchange.request.path}`,
          ),
        unexpected,
      };
      queue = [];
      cursor = 0;
      unexpected = [];
      requests = [];
      return findings;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

export type ProviderWireReplay = ReturnType<typeof installProviderWireReplay>;
