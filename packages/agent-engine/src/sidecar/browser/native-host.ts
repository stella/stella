import { Result } from "better-result";
import net from "node:net";
import { endianness } from "node:os";

import { browserBridgeAuthLine } from "./bridge";

/**
 * The native messaging host Chrome starts for the stella extension
 * (`stella-agent-sidecar --native-host`). It relays Chrome's framed messages
 * to the holder's browser bridge over its Unix socket, and the bridge's
 * lines back to Chrome. It reads nothing itself and talks to no network.
 *
 * It waits for the holder while Chrome keeps it running, and exits once
 * Chrome closes its input or the holder it reached goes away; the extension
 * then starts a new one.
 */

/** Chrome refuses a message from a host larger than this. */
const MAX_TO_CHROME_BYTES = 1024 * 1024;
/** Chrome sends at most this much in one message. */
const MAX_FROM_CHROME_BYTES = 64 * 1024 * 1024;
const LENGTH_BYTES = 4;
const LITTLE_ENDIAN = endianness() === "LE";

/** One message in Chrome's framing: its length in native byte order, then UTF-8 JSON. */
export const encodeNativeMessage = (json: string): Uint8Array | null => {
  const body = new TextEncoder().encode(json);
  if (body.byteLength > MAX_TO_CHROME_BYTES) {
    return null;
  }
  const frame = new Uint8Array(LENGTH_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, LITTLE_ENDIAN);
  frame.set(body, LENGTH_BYTES);
  return frame;
};

/**
 * Feeds Chrome's byte stream in; calls `onMessage` with each message's JSON
 * text. Returns false once a frame claims more than Chrome may send.
 */
export const nativeMessageReader = (onMessage: (json: string) => void) => {
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  return (chunk: Uint8Array): boolean => {
    const joined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    joined.set(buffer);
    joined.set(chunk, buffer.byteLength);
    buffer = joined;
    while (buffer.byteLength >= LENGTH_BYTES) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        LENGTH_BYTES,
      ).getUint32(0, LITTLE_ENDIAN);
      if (length > MAX_FROM_CHROME_BYTES) {
        return false;
      }
      if (buffer.byteLength < LENGTH_BYTES + length) {
        return true;
      }
      onMessage(
        decoder.decode(buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length)),
      );
      buffer = buffer.slice(LENGTH_BYTES + length);
    }
    return true;
  };
};

/** A JSON text as one line: Chrome's text re-serialised, never passed raw. */
const asLine = (json: string): string | null => {
  const parsed = Result.try((): unknown => JSON.parse(json));
  return Result.isOk(parsed) ? `${JSON.stringify(parsed.value)}\n` : null;
};

type NativeHostOptions = {
  /** The holder's browser bridge socket. */
  endpoint: string;
  /** The secret the bridge wrote beside it. */
  secret: string;
  /** Chrome's side: the host's standard input. */
  input: NodeJS.ReadableStream;
  /** Writes one frame to Chrome: the host's standard output. */
  output: (frame: Uint8Array) => void;
  /** How long to wait before looking for the holder again. */
  retryMs: number;
};

/** Relays until Chrome or the holder goes away. */
export const runNativeHost = async ({
  endpoint,
  input,
  output,
  retryMs,
  secret,
}: NativeHostOptions): Promise<void> => {
  const { promise: done, resolve } = Promise.withResolvers<null>();
  let socket: net.Socket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ended = false;

  const end = () => {
    if (ended) {
      return;
    }
    ended = true;
    if (retry !== null) {
      clearTimeout(retry);
    }
    socket?.destroy();
    resolve(null);
  };

  const read = nativeMessageReader((json) => {
    const line = asLine(json);
    if (line !== null) {
      socket?.write(line);
    }
  });
  input.on("data", (chunk: Uint8Array) => {
    if (!read(chunk)) {
      end();
    }
  });
  input.on("end", end);
  input.on("close", end);

  const connect = () => {
    retry = null;
    if (ended) {
      return;
    }
    let reached = false;
    const attempt = net.createConnection({ path: endpoint });
    const decoder = new TextDecoder();
    let buffer = "";
    attempt.on("connect", () => {
      reached = true;
      socket = attempt;
      attempt.write(browserBridgeAuthLine(secret));
    });
    attempt.on("data", (bytes: Uint8Array) => {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const frame = encodeNativeMessage(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (frame !== null) {
          output(frame);
        }
      }
    });
    attempt.on("error", () => {
      attempt.destroy();
    });
    attempt.on("close", () => {
      if (reached) {
        // The holder went away; Chrome starts a new host when it is back.
        end();
        return;
      }
      if (!ended) {
        retry = setTimeout(connect, retryMs);
      }
    });
  };
  connect();
  await done;
};
