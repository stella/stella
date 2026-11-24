import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { MAILBOX_MAX_MESSAGES } from "@stll/api-contract/mailbox";
import { assertProperty } from "@stll/property-testing";

import {
  mailboxWithLargeMessage,
  mailMessage,
  MATTER_CORRESPONDENCE,
  MBOX_VARIANTS,
  type MboxVariant,
  writeMbox,
} from "@/api/tests/fixtures/mbox";

import {
  MBOX_HEADER_MAX_BYTES,
  MBOX_MESSAGE_MAX_BYTES,
  MBOX_REREAD_MAX_BYTES,
  type MboxMessage,
  mboxMessageBytes,
  MboxScanner,
  scanMbox,
} from "./mbox";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The mailbox read in chunks cut at `cuts`, as a stream delivers it. */
const scanInChunks = (bytes: Uint8Array, cuts: readonly number[]) => {
  const messages: MboxMessage[] = [];
  const scanner = new MboxScanner((message) => {
    messages.push(message);
  }, true);
  let from = 0;
  for (const cut of [...cuts].toSorted((a, b) => a - b)) {
    scanner.push(bytes.subarray(from, cut));
    from = cut;
  }
  scanner.push(bytes.subarray(from));
  scanner.finish();
  return { messages, failure: scanner.failure, truncated: scanner.truncated };
};

const readBack = (messages: readonly MboxMessage[], file: Uint8Array) =>
  messages.map(({ offset, length, bounded }) =>
    decode(mboxMessageBytes(file.subarray(offset, offset + length), bounded)),
  );

const correspondence = (newline = "\n") =>
  MATTER_CORRESPONDENCE.map((message) => mailMessage(message, newline));

describe("a mailbox in every variant", () => {
  test.each(MBOX_VARIANTS)(
    "%s reads back every message exactly, with its From lines",
    (variant) => {
      const { bytes, expected } = writeMbox(correspondence(), variant);
      const { messages, failure } = scanMbox(bytes);
      expect(failure).toBeNull();
      expect(readBack(messages, bytes)).toEqual(expected.map(decode));
      // The fixture reaches the quoting rule: a body line starts `From `.
      expect(decode(bytes)).toMatch(/\n>?From now on/u);
      expect(messages.map(({ bounded }) => bounded)).toEqual(
        expected.map(() => variant === "mboxcl" || variant === "mboxcl2"),
      );
    },
  );

  test.each(MBOX_VARIANTS)(
    "%s with CRLF lines reads back the same",
    (variant) => {
      const { bytes, expected } = writeMbox(correspondence("\r\n"), variant, {
        newline: "\r\n",
      });
      const { messages } = scanMbox(bytes);
      expect(readBack(messages, bytes)).toEqual(expected.map(decode));
    },
  );

  test("an mboxcl2 body line starting From is no boundary", () => {
    const withBlankLine = writeMbox(
      [
        mailMessage({
          ...MATTER_CORRESPONDENCE[0]!,
          body: "Shrnutí jednání:\n\nFrom 9:00 to 11:30 the court heard both parties.",
        }),
      ],
      "mboxcl2",
    );
    // Unquoted after a blank line, so only the count keeps the body whole.
    expect(decode(withBlankLine.bytes)).toContain("\n\nFrom 9:00");
    const { messages } = scanMbox(withBlankLine.bytes);
    expect(messages).toHaveLength(1);
    expect(readBack(messages, withBlankLine.bytes)).toEqual(
      withBlankLine.expected.map(decode),
    );
  });

  test("a count that misses its separator falls back to the separators", () => {
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: "Shrnutí:\n\nFrom 9:00 the court heard both parties.",
      headers: ["Content-Length: 7"],
    });
    const next = mailMessage(MATTER_CORRESPONDENCE[2]!);
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const bytes = new TextEncoder().encode(
      `${separator}${decode(message)}\n${separator}${decode(next)}\n`,
    );
    const { messages } = scanMbox(bytes);
    // The count lands mid-body, so the body's own From line, which follows a
    // blank line, is a separator again, as in mboxo.
    expect(messages).toHaveLength(3);
    expect(messages.every(({ bounded }) => !bounded)).toBe(true);
    expect(readBack(messages, bytes)[0]).toEndWith("\n\nShrnutí:\n");
    expect(messages[1]?.length).toBe(0);
    expect(readBack(messages, bytes)[2]).toBe(decode(next));
  });

  test("a From line that does not follow a blank line is no boundary", () => {
    // Written unquoted and uncounted, as some exporters do: only a From line
    // after a blank line separates messages.
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: "Shrnutí jednání:\nFrom 9:00 to 11:30 the court heard both parties.",
    });
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const bytes = new TextEncoder().encode(
      `${separator}${decode(message)}\n${separator}${decode(message)}\n`,
    );
    expect(decode(bytes)).toContain(":\nFrom 9:00");
    const { messages } = scanMbox(bytes);
    expect(readBack(messages, bytes)).toEqual([
      decode(message),
      decode(message),
    ]);
  });

  test("wrong counts never make it read the mailbox again and again", () => {
    // Every message claims a body running far past the next ones: each miss
    // would read the rest of the mailbox again.
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: "ok",
      headers: ["Content-Length: 1000000"],
    });
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const one = `${separator}${decode(message)}\n`;
    const count = 3000;
    const bytes = new TextEncoder().encode(one.repeat(count));
    const messages: MboxMessage[] = [];
    const scanner = new MboxScanner((found) => {
      messages.push(found);
    });
    scanner.push(bytes);
    scanner.finish();
    expect(messages).toHaveLength(count);
    expect(messages.every(({ bounded }) => !bounded)).toBe(true);
    // Each byte once, plus at most the bound read again (and the one miss
    // that crossed it): reading every miss again would be thousands of times
    // the mailbox.
    expect(scanner.bytesRead).toBeLessThanOrEqual(
      bytes.byteLength + MBOX_REREAD_MAX_BYTES + 1_000_000,
    );
  });

  test("a count stated twice is not followed, even when one is not a number", () => {
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: "Shrnutí:\n\nFrom 9:00 the court heard both parties.",
      headers: ["Content-Length: 9", "Content-Length:"],
    });
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const bytes = new TextEncoder().encode(`${separator}${decode(message)}\n`);
    const { messages } = scanMbox(bytes);
    expect(messages.every(({ bounded }) => !bounded)).toBe(true);
    // Separators decide: the body's From line after a blank line splits it.
    expect(messages).toHaveLength(2);
  });

  test("a count that misses at a long line is decided the same in any chunks", () => {
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: `Shrnutí:\n\nFrom 9:00 the court heard both parties.\n${"x".repeat(80_000)}\n`,
      headers: ["Content-Length: 10"],
    });
    const next = mailMessage(MATTER_CORRESPONDENCE[2]!);
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const bytes = new TextEncoder().encode(
      `${separator}${decode(message)}\n${separator}${decode(next)}\n`,
    );
    const whole = scanMbox(bytes).messages.map(({ offset, length }) => [
      offset,
      length,
    ]);
    const cuts = Array.from(
      { length: Math.floor(bytes.byteLength / 997) },
      (_, index) => (index + 1) * 997,
    );
    expect(
      scanInChunks(bytes, cuts).messages.map(({ offset, length }) => [
        offset,
        length,
      ]),
    ).toEqual(whole);
    expect(whole).toHaveLength(3);
  });

  test("a last line too short to be a separator is not a mailbox's start", () => {
    for (const text of ["abc", "From"]) {
      expect(scanMbox(new TextEncoder().encode(text)).failure?._tag).toBe(
        "MboxParseError",
      );
    }
    // A file cut in a line break is still a mailbox with nothing in it.
    expect(scanMbox(new TextEncoder().encode("\r")).failure).toBeNull();
  });

  test("a count past the file's end falls back to the separators", () => {
    const message = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      headers: ["Content-Length: 900000"],
    });
    const separator =
      "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n";
    const bytes = new TextEncoder().encode(
      `${separator}${decode(message)}\n${separator}${decode(message)}\n`,
    );
    const { messages } = scanMbox(bytes);
    expect(messages).toHaveLength(2);
    expect(readBack(messages, bytes)).toEqual([
      decode(message),
      decode(message),
    ]);
  });
});

describe("what a mailbox holds", () => {
  test("an empty file, or blank lines only, holds no messages", () => {
    for (const text of ["", "\n", "\r\n\n"]) {
      const { messages, failure } = scanMbox(new TextEncoder().encode(text));
      expect(messages).toEqual([]);
      expect(failure).toBeNull();
    }
  });

  test("a file that does not start with a separator is not a mailbox", () => {
    const { failure } = scanMbox(mailMessage(MATTER_CORRESPONDENCE[0]!));
    expect(failure?._tag).toBe("MboxParseError");
  });

  test("a damaged trailing message is listed without a header", () => {
    const { bytes } = writeMbox(correspondence(), "mboxrd");
    const damaged = new Uint8Array([
      ...bytes,
      ...new TextEncoder().encode("From kalina@ak-kalina-vesela.cz Tue"),
    ]);
    const { messages } = scanMbox(damaged);
    expect(messages).toHaveLength(MATTER_CORRESPONDENCE.length + 1);
    expect(messages.at(-1)).toMatchObject({ length: 0, headerComplete: false });
  });

  test("a header is read up to its blank line, at most its bound", () => {
    const { bytes } = writeMbox(correspondence(), "mboxo");
    const [first] = scanMbox(bytes).messages;
    expect(first?.headerComplete).toBe(true);
    expect(decode(first?.header ?? new Uint8Array())).toEndWith("8bit\n\n");

    const huge = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      headers: Array.from(
        { length: 2000 },
        (_, index) => `X-Spis-Poznamka-${String(index)}: ${"x".repeat(60)}`,
      ),
    });
    const oversized = writeMbox([huge], "mboxo");
    const { messages } = scanMbox(oversized.bytes);
    expect(messages[0]?.headerComplete).toBe(false);
    expect(messages[0]?.header.byteLength).toBe(MBOX_HEADER_MAX_BYTES);
    expect(readBack(messages, oversized.bytes)).toEqual(
      oversized.expected.map(decode),
    );
  });

  test("a message over the size bound is measured, never kept", () => {
    const bytes = mailboxWithLargeMessage(
      MBOX_MESSAGE_MAX_BYTES + 1024 * 1024,
      writeMbox(correspondence(), "mboxcl2").bytes,
    );
    const { messages } = scanMbox(bytes, { keepMessages: true });
    expect(messages).toHaveLength(MATTER_CORRESPONDENCE.length + 1);
    expect(messages[0]?.stored).toBeNull();
    expect(messages[0]?.length).toBeGreaterThan(MBOX_MESSAGE_MAX_BYTES);
    expect(messages.slice(1).every(({ stored }) => stored !== null)).toBe(true);
  });

  test("it lists at most the bound and says when there are more", () => {
    const tiny = mailMessage({ ...MATTER_CORRESPONDENCE[0]!, body: "ok" });
    const atBound = writeMbox(
      Array.from({ length: MAILBOX_MAX_MESSAGES }, () => tiny),
      "mboxo",
    );
    const listed = scanMbox(atBound.bytes);
    expect(listed.messages).toHaveLength(MAILBOX_MAX_MESSAGES);
    expect(listed.truncated).toBe(false);

    const past = writeMbox(
      Array.from({ length: MAILBOX_MAX_MESSAGES + 1 }, () => tiny),
      "mboxo",
    );
    const cut = scanMbox(past.bytes);
    expect(cut.messages).toHaveLength(MAILBOX_MAX_MESSAGES);
    expect(cut.truncated).toBe(true);
  });
});

describe("From unquoting", () => {
  test.each([
    [">From here\n", "From here\n"],
    [">>From here\n", ">From here\n"],
    ["a\n>From b\n>>>From c\n", "a\nFrom b\n>>From c\n"],
    [">Fromage\n", ">Fromage\n"],
    ["x >From y\n", "x >From y\n"],
    ["> From y\n", "> From y\n"],
  ])("%j reads as %j", (stored, read) => {
    const bytes = new TextEncoder().encode(stored);
    expect(decode(mboxMessageBytes(bytes, false))).toBe(read);
    // A counted body is taken as stored.
    expect(decode(mboxMessageBytes(bytes, true))).toBe(stored);
  });
});

const BODY_LINES = [
  "From the court's summons: hearing at 9:00.",
  ">From a quoted reply",
  ">>From deeper",
  "",
  "Dobrý den,",
  "S pozdravem, Kalina",
  "From",
  "From ",
  "> From spaced",
  "Content-Length: 3",
] as const;

const messageArbitrary = fc
  .record({
    lines: fc.array(fc.constantFrom(...BODY_LINES), { maxLength: 12 }),
    subject: fc.option(fc.constantFrom("Spis 23 C 118/2026", "Re: smír"), {
      nil: null,
    }),
  })
  .map(({ lines, subject }) =>
    mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      subject,
      body: lines.join("\n"),
    }),
  );

describe("any mailbox", () => {
  test("any mailbox reads back every message after unquoting, in any chunks", () => {
    assertProperty(
      "any mailbox reads back every message after unquoting, in any chunks",
      fc.property(
        fc.array(messageArbitrary, { maxLength: 6 }),
        fc.constantFrom<MboxVariant>(...MBOX_VARIANTS),
        fc.constantFrom("\n", "\r\n"),
        fc.array(fc.nat(), { maxLength: 6 }),
        (messages, variant, newline, cutSeeds) => {
          const written = writeMbox(
            messages.map((message) =>
              newline === "\n"
                ? message
                : new TextEncoder().encode(
                    decode(message).replaceAll("\n", "\r\n"),
                  ),
            ),
            variant,
            { newline },
          );
          const cuts = cutSeeds.map(
            (seed) => seed % (written.bytes.byteLength + 1),
          );
          const { messages: read, failure } = scanInChunks(written.bytes, cuts);
          expect(failure).toBeNull();
          expect(
            read.map(({ stored, bounded }) =>
              decode(mboxMessageBytes(stored ?? new Uint8Array(), bounded)),
            ),
          ).toEqual(written.expected.map(decode));
          expect(readBack(read, written.bytes)).toEqual(
            written.expected.map(decode),
          );
        },
      ),
    );
  });

  test("boundaries never fall inside a body its count bounds", () => {
    assertProperty(
      "boundaries never fall inside a body its count bounds",
      fc.property(
        fc.array(messageArbitrary, { minLength: 1, maxLength: 6 }),
        (messages) => {
          const written = writeMbox(messages, "mboxcl2");
          const { messages: read } = scanMbox(written.bytes);
          expect(read).toHaveLength(messages.length);
          expect(read.every(({ bounded }) => bounded)).toBe(true);
        },
      ),
    );
  });
});
