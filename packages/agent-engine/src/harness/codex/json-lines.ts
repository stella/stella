/**
 * Newline framing for a byte stream: splits on `\n` and decodes each line as
 * UTF-8 only once it is complete. Lengths are counted in bytes, and every
 * line is measured before it is delivered, so no line over the limit is
 * delivered, wherever its newline falls among the chunks.
 */

const NEWLINE = 0x0a;

type LineReaderOptions = {
  maxLineBytes: number;
  line: (line: string) => void;
  /** A line passed the limit; nothing after it is delivered. */
  oversized: () => void;
};

export type LineReader = {
  push: (chunk: Uint8Array) => void;
  /** The stream ended: a last line without a newline is still delivered. */
  end: () => void;
};

export const createLineReader = ({
  maxLineBytes,
  line,
  oversized,
}: LineReaderOptions): LineReader => {
  const decoder = new TextDecoder();
  const parts: Uint8Array[] = [];
  const state = { bytes: 0, stopped: false };

  const refuse = () => {
    state.stopped = true;
    parts.length = 0;
    state.bytes = 0;
    oversized();
  };

  /** The held start of the line plus `tail`, decoded; the hold is emptied. */
  const take = (tail: Uint8Array) => {
    const whole = new Uint8Array(state.bytes + tail.length);
    let at = 0;
    for (const part of [...parts, tail]) {
      whole.set(part, at);
      at += part.length;
    }
    parts.length = 0;
    state.bytes = 0;
    return decoder.decode(whole);
  };

  return {
    push: (chunk) => {
      let start = 0;
      let newline = chunk.indexOf(NEWLINE);
      while (newline !== -1) {
        if (state.stopped) {
          return;
        }
        if (state.bytes + newline - start > maxLineBytes) {
          refuse();
          return;
        }
        line(take(chunk.subarray(start, newline)));
        start = newline + 1;
        newline = chunk.indexOf(NEWLINE, start);
      }
      if (state.stopped || start === chunk.length) {
        return;
      }
      // Copied: the stream may reuse the chunk's memory for its next read.
      parts.push(chunk.slice(start));
      state.bytes += chunk.length - start;
      if (state.bytes > maxLineBytes) {
        refuse();
      }
    },
    end: () => {
      if (!state.stopped && state.bytes > 0) {
        line(take(new Uint8Array(0)));
      }
    },
  };
};
