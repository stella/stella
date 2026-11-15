/**
 * The stella browser's protocol channel: the pipe Chrome opens with
 * `--remote-debugging-pipe`. The holder writes to the browser's fd 3 and
 * reads its fd 4; each message is one JSON text followed by a NUL byte. No
 * port, no file: only the process holding the pipe's ends can speak to the
 * browser.
 */

/** A message longer than this ends the browser: no answer the holder asks for comes near it. */
const CDP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const NUL = 0;

const encoder = new TextEncoder();

/** One message as the pipe carries it. */
export const encodeCdpFrame = (json: string): Uint8Array => {
  const body = encoder.encode(json);
  const frame = new Uint8Array(body.length + 1);
  frame.set(body);
  frame[body.length] = NUL;
  return frame;
};

type CdpFrameReaderOptions = {
  maxMessageBytes: number;
  /** Each complete message, decoded. */
  onMessage: (json: string) => void;
};

/**
 * Splits the browser's output into messages. Bytes arrive in any pieces: a
 * message may span chunks, and a chunk may hold several. `push` answers
 * false, and drops what it holds, once a message runs over the cap; the
 * caller then ends the browser, since the stream can no longer be trusted.
 */
export const createCdpFrameReader = ({
  maxMessageBytes,
  onMessage,
}: CdpFrameReaderOptions) => {
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let overflowed = false;
  return {
    push: (chunk: Uint8Array): boolean => {
      if (overflowed) {
        return false;
      }
      let start = 0;
      let end = chunk.indexOf(NUL, start);
      while (end !== -1) {
        const piece = chunk.subarray(start, end);
        if (pendingBytes + piece.length > maxMessageBytes) {
          overflowed = true;
          pending = [];
          pendingBytes = 0;
          return false;
        }
        const message =
          pending.length === 0
            ? piece
            : Buffer.concat([...pending, piece], pendingBytes + piece.length);
        pending = [];
        pendingBytes = 0;
        onMessage(decoder.decode(message));
        start = end + 1;
        end = chunk.indexOf(NUL, start);
      }
      const rest = chunk.subarray(start);
      if (pendingBytes + rest.length > maxMessageBytes) {
        overflowed = true;
        pending = [];
        pendingBytes = 0;
        return false;
      }
      if (rest.length > 0) {
        // A copy: the caller may reuse the chunk's memory.
        pending.push(rest.slice());
        pendingBytes += rest.length;
      }
      return true;
    },
  };
};

/** Why a pipe stopped carrying messages. */
export type CdpPipeEnd =
  | { type: "end-of-file" }
  | { type: "too-large" }
  | { type: "closed" }
  | { type: "failed" };

/** The two ends of the pipe the holder keeps, as streams. */
type PipeEnds = {
  /** The browser's fd 3: the holder writes here. */
  input: NodeJS.WritableStream & { destroy: () => void };
  /** The browser's fd 4: the holder reads here. */
  output: NodeJS.ReadableStream & { destroy: () => void };
};

export type CdpPipe = {
  send: (json: string) => boolean;
  /** Settles once, when the pipe ends for any reason. */
  ended: Promise<CdpPipeEnd>;
  close: () => void;
};

/** Messages over the pipe's two ends, until either end fails or closes. */
export const connectCdpPipe = (
  { input, output }: PipeEnds,
  {
    maxMessageBytes = CDP_MAX_MESSAGE_BYTES,
    onMessage,
  }: { maxMessageBytes?: number; onMessage: (json: string) => void },
): CdpPipe => {
  const { promise: ended, resolve } = Promise.withResolvers<CdpPipeEnd>();
  let open = true;
  const finish = (end: CdpPipeEnd) => {
    if (!open) {
      return;
    }
    open = false;
    input.destroy();
    output.destroy();
    resolve(end);
  };
  const reader = createCdpFrameReader({ maxMessageBytes, onMessage });
  output.on("data", (chunk: Uint8Array) => {
    if (open && !reader.push(chunk)) {
      finish({ type: "too-large" });
    }
  });
  output.on("end", () => {
    finish({ type: "end-of-file" });
  });
  output.on("error", () => {
    finish({ type: "failed" });
  });
  input.on("error", () => {
    finish({ type: "failed" });
  });
  return {
    send: (json) => {
      if (!open) {
        return false;
      }
      input.write(encodeCdpFrame(json));
      return true;
    },
    ended,
    close: () => {
      finish({ type: "closed" });
    },
  };
};
