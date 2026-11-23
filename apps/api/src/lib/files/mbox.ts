/**
 * Reads a mailbox (`.mbox`, RFC 4155) one chunk at a time: where each
 * message starts and ends and the first bytes of its header, holding at
 * most one message at a time. Every variant mail clients write is read:
 *
 * - mboxo and mboxrd: a message ends where a line starting `From ` follows
 *   a blank line (or opens the file). A body line that started `From ` was
 *   written quoted (`>From `); reading strips exactly one `>` from every
 *   line matching `^>+From `.
 * - mboxcl and mboxcl2: the header's `Content-Length` counts the body, so a
 *   body line starting `From ` is no boundary. The count is trusted only
 *   where it lands on the next separator (or the file's end); otherwise the
 *   message ends at the first separator after a blank line, as in mboxo. A
 *   body its count bounds is read as stored, never unquoted.
 *
 * Lines may end in LF or CRLF. Anything but blank lines before the first
 * separator means the file is not a mailbox.
 */
import { TaggedError } from "better-result";

import { MAILBOX_MAX_MESSAGES } from "@stll/api-contract/mailbox";

/** One message is at most this large; a larger one is listed, never read. */
export const MBOX_MESSAGE_MAX_BYTES = 32 * 1024 * 1024;

/** The most header bytes a message's list row is read from. */
export const MBOX_HEADER_MAX_BYTES = 64 * 1024;

export class MboxParseError extends TaggedError("MboxParseError")<{
  message: string;
}> {}

/** One message as its mailbox stores it. */
export type MboxMessageSpan = {
  /** Its position in the mailbox. */
  readonly index: number;
  /** Where its first header byte sits in the file. */
  readonly offset: number;
  /** Its bytes as stored, from its first header byte to its end. */
  readonly length: number;
  /** Whether a `Content-Length` bounded it; such a body is never unquoted. */
  readonly bounded: boolean;
  /** Its header block, or its first `MBOX_HEADER_MAX_BYTES` bytes. */
  readonly header: Uint8Array;
  /** Whether the header block ended (with a blank line) within those. */
  readonly headerComplete: boolean;
};

/**
 * A message as the scanner reports it: its bytes as stored when the reader
 * keeps messages and it is not larger than one message may be.
 */
export type MboxMessage = MboxMessageSpan & {
  readonly stored: Uint8Array | null;
};

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_ = new TextEncoder().encode("From ");
const FROM_LENGTH = FROM_.byteLength;

/** A run of bytes kept as the chunks it arrived in. */
class ByteRun {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength > 0) {
      this.chunks.push(bytes);
      this.length += bytes.byteLength;
    }
  }

  /** Bytes `start` to `end` of the run, copied into one array. */
  slice(start: number, end: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, end - start));
    let position = 0;
    for (const chunk of this.chunks) {
      const from = Math.max(start - position, 0);
      const to = Math.min(end - position, chunk.byteLength);
      if (from < to) {
        out.set(chunk.subarray(from, to), position + from - start);
      }
      position += chunk.byteLength;
      if (position >= end) {
        break;
      }
    }
    return out;
  }

  byteAt(index: number): number | undefined {
    let position = 0;
    for (const chunk of this.chunks) {
      if (index < position + chunk.byteLength) {
        return chunk[index - position];
      }
      position += chunk.byteLength;
    }
    return undefined;
  }

  clear(): void {
    this.chunks.length = 0;
    this.length = 0;
  }
}

/** Where a header block ends: just past its first blank line. */
const headerBlockEnd = (header: Uint8Array): number | null => {
  let lineStart = 0;
  for (;;) {
    const newline = header.indexOf(LF, lineStart);
    if (newline === -1) {
      return null;
    }
    const lineLength = newline - lineStart;
    if (lineLength === 0 || (lineLength === 1 && header[lineStart] === CR)) {
      return newline + 1;
    }
    lineStart = newline + 1;
  }
};

const CONTENT_LENGTH = /^content-length[ \t]*:[ \t]*(\d{1,10})[ \t]*\r?$/gimu;

/** The body length a header states; null when it states none, or two. */
export const statedContentLength = (header: Uint8Array): number | null => {
  const text = new TextDecoder("latin1").decode(header);
  const matches = [...text.matchAll(CONTENT_LENGTH)];
  const value = matches.length === 1 ? matches[0]?.[1] : undefined;
  return value === undefined ? null : Number(value);
};

type Pending =
  /** Inside a body its `Content-Length` says ends at `end`. */
  | { readonly type: "counted"; readonly end: number }
  /** The counted body ended at `end` and a blank line followed. */
  | { readonly type: "blank"; readonly end: number }
  /** No count, or one that did not land on a separator. */
  | { readonly type: "none" };

type OpenMessage = {
  /** Where its separator line starts; the kept bytes start here. */
  readonly separator: number;
  /** Where its header starts, once its separator line has ended. */
  offset: number | null;
  pending: Pending;
  /** The first separator after a blank line inside a counted body. */
  candidate: { readonly separator: number; readonly end: number } | null;
  header: Uint8Array | null;
  headerComplete: boolean;
};

/**
 * The streaming reader. Hand it the file's bytes with `push`, then call
 * `finish`; it calls `onMessage` once per message, in order. It reports at
 * most `MAILBOX_MAX_MESSAGES` messages and sets `truncated` once it sees a
 * further one; a file that is not a mailbox sets `failure`. Either stops it
 * (`done`), and it ignores anything pushed after.
 */
export class MboxScanner {
  /** Bytes read so far (moves back when a count is read again). */
  private position = 0;
  private lineStart = 0;
  /** How many bytes of the current line have been seen. */
  private lineSeen = 0;
  private readonly lineHead = new Uint8Array(FROM_LENGTH);
  private previousBlank = true;
  private previousBlankStart = 0;
  private open: OpenMessage | null = null;
  /** The open message's bytes from its separator, while they are needed. */
  private readonly run = new ByteRun();
  private runDropped = false;
  private count = 0;
  private stopped = false;
  truncated = false;
  failure: MboxParseError | null = null;

  private readonly onMessage: (message: MboxMessage) => void;
  /** Report each message's stored bytes, as text extraction needs. */
  private readonly keepMessages: boolean;

  constructor(onMessage: (message: MboxMessage) => void, keepMessages = false) {
    this.onMessage = onMessage;
    this.keepMessages = keepMessages;
  }

  /** Whether nothing pushed from now on can change what is reported. */
  get done(): boolean {
    return this.stopped;
  }

  push(chunk: Uint8Array): void {
    const queue: Uint8Array[] = [chunk];
    for (
      let next = queue.shift();
      next !== undefined && !this.stopped;
      next = queue.shift()
    ) {
      this.consume(next, queue);
    }
  }

  finish(): void {
    if (this.stopped) {
      return;
    }
    const open = this.open;
    if (open !== null) {
      const { pending } = open;
      if (pending.type === "blank") {
        this.close(open, pending.end, true);
      } else if (pending.type === "counted" && pending.end === this.position) {
        this.close(open, pending.end, true);
      } else if (pending.type === "counted" && open.candidate !== null) {
        // The count ran past the file's end: read again from the first
        // separator inside it.
        const again = this.readAgain(open);
        this.push(again);
        this.finish();
        return;
      } else {
        // The last message ends with the file, less the blank line a
        // writer puts after every message.
        const lastLineBlank = this.lineSeen === 0 && this.previousBlank;
        this.close(
          open,
          lastLineBlank &&
            this.previousBlankStart >= (open.offset ?? this.position)
            ? this.previousBlankStart
            : this.position,
          false,
        );
      }
    }
    this.stopped = true;
  }

  private consume(chunk: Uint8Array, queue: Uint8Array[]): void {
    let index = 0;
    while (index < chunk.byteLength && !this.stopped) {
      const newline = chunk.indexOf(LF, index);
      const lineEnd = newline === -1 ? chunk.byteLength : newline + 1;
      const again = this.scan(chunk.subarray(index, lineEnd), newline !== -1);
      if (again !== null) {
        queue.unshift(again, chunk.subarray(lineEnd));
        return;
      }
      index = lineEnd;
    }
  }

  /**
   * The current line's next bytes, ending it when `ends`. Returns the bytes
   * to read again when the open message's count proved wrong.
   */
  private scan(bytes: Uint8Array, ends: boolean): Uint8Array | null {
    const seenBefore = this.lineSeen;
    for (
      let at = 0;
      at < bytes.byteLength && seenBefore + at < FROM_LENGTH;
      at += 1
    ) {
      this.lineHead[seenBefore + at] = bytes[at] ?? 0;
    }
    this.lineSeen += bytes.byteLength;
    this.position += bytes.byteLength;
    this.keep(bytes);
    const headKnown =
      seenBefore < FROM_LENGTH && (this.lineSeen >= FROM_LENGTH || ends);
    if (headKnown) {
      const again = this.atLineHead(ends, seenBefore, bytes);
      if (again !== null) {
        return again;
      }
    }
    return ends ? this.atLineEnd() : null;
  }

  /** Keep the open message's bytes while they may be reported or reread. */
  private keep(bytes: Uint8Array): void {
    const open = this.open;
    if (open === null || this.runDropped) {
      return;
    }
    const needed =
      this.keepMessages || open.header === null || open.pending.type !== "none";
    if (!needed) {
      this.run.clear();
      this.runDropped = true;
      return;
    }
    if (
      this.run.length + bytes.byteLength >
      MBOX_MESSAGE_MAX_BYTES + MBOX_HEADER_MAX_BYTES
    ) {
      // Past any message that may be read: keep only what is known.
      this.captureHeader(open);
      this.run.clear();
      this.runDropped = true;
      open.pending = { type: "none" };
      open.candidate = null;
      return;
    }
    this.run.push(bytes);
  }

  private get lineIsBlank(): boolean {
    return (
      this.lineSeen === 1 || (this.lineSeen === 2 && this.lineHead[0] === CR)
    );
  }

  private get lineIsSeparator(): boolean {
    return (
      this.lineSeen >= FROM_LENGTH &&
      FROM_.every((byte, index) => this.lineHead[index] === byte)
    );
  }

  private atLineHead(
    ends: boolean,
    seenBefore: number,
    bytes: Uint8Array,
  ): Uint8Array | null {
    const open = this.open;
    const { lineStart } = this;
    const separator = this.lineIsSeparator;
    if (open === null) {
      if (separator && this.previousBlank) {
        this.begin(seenBefore, bytes);
      } else if (!(ends && this.lineIsBlank)) {
        this.failure = new MboxParseError({
          message: "The file does not start with a message separator",
        });
        this.stopped = true;
      }
      return null;
    }
    const { pending } = open;
    if (pending.type === "counted" && lineStart < pending.end) {
      if (
        separator &&
        this.previousBlank &&
        open.candidate === null &&
        open.header !== null
      ) {
        open.candidate = { separator: lineStart, end: this.previousBlankStart };
      }
      return null;
    }
    if (pending.type === "counted" && lineStart === pending.end) {
      if (separator) {
        this.close(open, pending.end, true);
        this.begin(seenBefore, bytes);
        return null;
      }
      if (ends && this.lineIsBlank) {
        open.pending = { type: "blank", end: pending.end };
        return null;
      }
      return this.miscounted(open);
    }
    if (pending.type !== "none") {
      if (pending.type === "blank" && separator) {
        this.close(open, pending.end, true);
        this.begin(seenBefore, bytes);
        return null;
      }
      return this.miscounted(open);
    }
    if (
      separator &&
      this.previousBlank &&
      open.header !== null &&
      open.offset !== null
    ) {
      this.close(open, Math.max(open.offset, this.previousBlankStart), false);
      this.begin(seenBefore, bytes);
    }
    return null;
  }

  private atLineEnd(): Uint8Array | null {
    const open = this.open;
    const blank = this.lineIsBlank;
    const lineEnd = this.position;
    if (open !== null) {
      if (open.offset === null) {
        // The separator line ended; the header starts here.
        open.offset = lineEnd;
      } else if (
        open.header === null &&
        (blank || lineEnd - open.offset >= MBOX_HEADER_MAX_BYTES)
      ) {
        this.captureHeader(open);
        if (blank && open.headerComplete) {
          this.countBody(open, lineEnd);
        }
      }
      // A counted body ending mid-line: the rest of the line must be only
      // its line break, a blank line in all but name.
      if (open.pending.type === "counted") {
        const { end } = open.pending;
        if (this.lineStart < end && end < lineEnd) {
          const rest = lineEnd - end;
          const restIsBreak =
            rest === 1 ||
            (rest === 2 && this.run.byteAt(end - open.separator) === CR);
          if (!restIsBreak) {
            const again = this.miscounted(open);
            if (again !== null) {
              return again;
            }
          } else {
            open.pending = { type: "blank", end };
          }
        }
      }
    }
    this.previousBlank = blank;
    if (blank) {
      this.previousBlankStart = this.lineStart;
    }
    this.lineStart = lineEnd;
    this.lineSeen = 0;
    return null;
  }

  /** A message starts at the current line, its separator. */
  private begin(seenBefore: number, bytes: Uint8Array): void {
    if (this.count >= MAILBOX_MAX_MESSAGES) {
      this.truncated = true;
      this.stopped = true;
      return;
    }
    this.run.clear();
    this.runDropped = false;
    this.run.push(this.lineHead.slice(0, seenBefore));
    this.run.push(bytes);
    this.open = {
      separator: this.lineStart,
      offset: null,
      pending: { type: "none" },
      candidate: null,
      header: null,
      headerComplete: false,
    };
  }

  private captureHeader(open: OpenMessage): void {
    if (open.header !== null || open.offset === null || this.runDropped) {
      return;
    }
    const start = open.offset - open.separator;
    const header = this.run.slice(
      start,
      Math.min(this.run.length, start + MBOX_HEADER_MAX_BYTES),
    );
    const end = headerBlockEnd(header);
    open.header = end === null ? header : header.subarray(0, end);
    open.headerComplete = end !== null;
  }

  private countBody(open: OpenMessage, bodyStart: number): void {
    const stated =
      open.header === null ? null : statedContentLength(open.header);
    if (stated === null || open.offset === null) {
      return;
    }
    const end = bodyStart + stated;
    // A count past what one message may be is never followed.
    if (end - open.offset <= MBOX_MESSAGE_MAX_BYTES) {
      open.pending = { type: "counted", end };
    }
  }

  /** The count did not land on a separator. */
  private miscounted(open: OpenMessage): Uint8Array | null {
    open.pending = { type: "none" };
    if (open.candidate === null) {
      // No separator inside the counted body: the message goes on.
      return null;
    }
    return this.readAgain(open);
  }

  /**
   * Ends the open message at the first separator inside its counted body
   * and rewinds to that separator: the bytes since are to be read again.
   */
  private readAgain(open: OpenMessage): Uint8Array {
    const candidate = open.candidate;
    if (candidate === null) {
      return new Uint8Array();
    }
    const again = this.run.slice(
      candidate.separator - open.separator,
      this.position - open.separator,
    );
    this.close(open, candidate.end, false);
    this.position = candidate.separator;
    this.lineStart = candidate.separator;
    this.lineSeen = 0;
    this.previousBlank = true;
    this.previousBlankStart = candidate.end;
    return again;
  }

  private close(open: OpenMessage, end: number, bounded: boolean): void {
    this.captureHeader(open);
    this.open = null;
    const offset = open.offset ?? end;
    const length = Math.max(0, end - offset);
    const stored =
      this.keepMessages && !this.runDropped && length <= MBOX_MESSAGE_MAX_BYTES
        ? this.run.slice(offset - open.separator, end - open.separator)
        : null;
    const index = this.count;
    this.count += 1;
    this.run.clear();
    this.onMessage({
      index,
      offset,
      length,
      bounded,
      header: open.header ?? new Uint8Array(),
      headerComplete: open.headerComplete,
      stored,
    });
  }
}

/**
 * A stored message's bytes as the email it is: a body its count bounds as
 * stored, any other with one `>` taken from every line matching `^>+From `.
 */
export const mboxMessageBytes = (
  stored: Uint8Array,
  bounded: boolean,
): Uint8Array => {
  if (bounded) {
    return stored;
  }
  const kept: Uint8Array[] = [];
  let copiedTo = 0;
  let lineStart = 0;
  while (lineStart < stored.byteLength) {
    if (stored[lineStart] === GT) {
      let at = lineStart;
      while (stored[at] === GT) {
        at += 1;
      }
      if (FROM_.every((byte, index) => stored[at + index] === byte)) {
        kept.push(stored.subarray(copiedTo, lineStart));
        copiedTo = lineStart + 1;
      }
    }
    const newline = stored.indexOf(LF, lineStart);
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  if (copiedTo === 0) {
    return stored;
  }
  kept.push(stored.subarray(copiedTo));
  const out = new Uint8Array(
    kept.reduce((total, part) => total + part.byteLength, 0),
  );
  let position = 0;
  for (const part of kept) {
    out.set(part, position);
    position += part.byteLength;
  }
  return out;
};

/** Every message of a mailbox held in memory, as the scanner reports them. */
export const scanMbox = (
  bytes: Uint8Array,
  options: { keepMessages?: boolean } = {},
): {
  messages: MboxMessage[];
  truncated: boolean;
  failure: MboxParseError | null;
} => {
  const messages: MboxMessage[] = [];
  const scanner = new MboxScanner(
    (message) => messages.push(message),
    options.keepMessages ?? false,
  );
  scanner.push(bytes);
  scanner.finish();
  return { messages, truncated: scanner.truncated, failure: scanner.failure };
};
