import { panic } from "better-result";

/**
 * Mailboxes built in tests: invented correspondence of an invented law firm,
 * written the way each mail client variant writes it.
 */

/** How a mailbox writer separates and quotes its messages. */
export const MBOX_VARIANTS = ["mboxo", "mboxrd", "mboxcl", "mboxcl2"] as const;
export type MboxVariant = (typeof MBOX_VARIANTS)[number];

const encoder = new TextEncoder();

type MailAttachment = {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
};

export type MailMessage = {
  readonly from: string;
  readonly to: string;
  readonly subject: string | null;
  readonly date: string | null;
  readonly body: string;
  readonly attachments?: readonly MailAttachment[];
  /** Further header lines, written as given. */
  readonly headers?: readonly string[];
};

// A header carries non-ASCII text as an encoded word (RFC 2047), as mail
// clients write it.
const encodedWord = (text: string): string =>
  // oxlint-disable-next-line no-control-regex -- the ASCII range is the test
  /^[\x00-\x7f]*$/u.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;

/** An address header's value, its display name encoded where it must be. */
const addressValue = (value: string): string => {
  const named = /^(?<name>.+?)\s*<(?<address>[^>]+)>$/u.exec(value);
  const name = named?.groups?.["name"];
  const address = named?.groups?.["address"];
  return name === undefined || address === undefined
    ? value
    : `${encodedWord(name)} <${address}>`;
};

/** One message as an RFC 822 email, its lines ending in `newline`. */
export const mailMessage = (
  {
    from,
    to,
    subject,
    date,
    body,
    attachments = [],
    headers = [],
  }: MailMessage,
  newline = "\n",
): Uint8Array => {
  const head = [
    `From: ${addressValue(from)}`,
    `To: ${addressValue(to)}`,
    ...(subject === null ? [] : [`Subject: ${encodedWord(subject)}`]),
    ...(date === null ? [] : [`Date: ${date}`]),
    "MIME-Version: 1.0",
    ...headers,
  ];
  const lines =
    attachments.length === 0
      ? [
          ...head,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: 8bit",
          "",
          ...body.split("\n"),
        ]
      : [
          ...head,
          'Content-Type: multipart/mixed; boundary="SPIS-HRANICE"',
          "",
          "--SPIS-HRANICE",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: 8bit",
          "",
          ...body.split("\n"),
          ...attachments.flatMap(({ fileName, mediaType, bytes }) => [
            "--SPIS-HRANICE",
            `Content-Type: ${mediaType}`,
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename="${fileName}"`,
            "",
            ...(Buffer.from(bytes).toString("base64").match(/.{1,76}/gu) ??
              []),
          ]),
          "--SPIS-HRANICE--",
        ];
  return encoder.encode(`${lines.join(newline)}${newline}`);
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

const FROM_LINE = /^(>*From )/gmu;
const BARE_FROM_LINE = /^(From )/gmu;

const quote = (text: string, variant: MboxVariant): string => {
  switch (variant) {
    case "mboxrd":
      return text.replace(FROM_LINE, ">$1");
    case "mboxo":
    case "mboxcl":
      return text.replace(BARE_FROM_LINE, ">$1");
    case "mboxcl2":
      return text;
    default:
      variant satisfies never;
      return text;
  }
};

// Bytes as one character each (ISO 8859-1), so quoting never alters a byte
// it does not mean to. The WHATWG "latin1" decoder is windows-1252 instead.
const asBinaryText = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("latin1");

/** Where a message's header ends and its body starts. */
const splitHeader = (message: string, newline: string) => {
  const end = message.indexOf(`${newline}${newline}`);
  return end === -1
    ? { header: message, body: "" }
    : {
        header: message.slice(0, end + newline.length),
        body: message.slice(end + newline.length * 2),
      };
};

export type WrittenMailbox = {
  readonly bytes: Uint8Array;
  /** Each message as reading it must give it back. */
  readonly expected: readonly Uint8Array[];
};

/**
 * A mailbox of `messages` as `variant` writes it: a `From ` line before
 * each, a blank line after each, body lines starting `From ` quoted as the
 * variant quotes them, and a `Content-Length` header where it counts.
 */
export const writeMbox = (
  messages: readonly Uint8Array[],
  variant: MboxVariant,
  {
    newline = "\n",
    sender = "kalina@ak-kalina-vesela.cz",
  }: { newline?: string; sender?: string } = {},
): WrittenMailbox => {
  const counted = variant === "mboxcl" || variant === "mboxcl2";
  const parts: Uint8Array[] = [];
  const expected: Uint8Array[] = [];
  for (const [index, message] of messages.entries()) {
    const text = asBinaryText(message);
    const { header, body } = splitHeader(text, newline);
    const quotedBody = quote(body, variant);
    const stored = counted
      ? `${header}Content-Length: ${String(quotedBody.length)}${newline}${newline}${quotedBody}`
      : `${quote(header, variant)}${newline}${quotedBody}`;
    const storedBytes = Buffer.from(stored, "latin1");
    parts.push(
      encoder.encode(
        `From ${sender} Tue Nov ${String(10 + (index % 18))} 09:30:00 2026${newline}`,
      ),
      storedBytes,
      encoder.encode(newline),
    );
    // A counted message reads back as stored, an uncounted one unquoted.
    // mboxo never quoted a line already starting `>From `, so reading takes
    // one `>` from it all the same: that variant cannot keep such a line.
    expected.push(
      counted
        ? new Uint8Array(storedBytes)
        : Buffer.from(
            variant === "mboxo" ? text.replace(/^>(>*From )/gmu, "$1") : text,
            "latin1",
          ),
    );
  }
  return { bytes: concat(parts), expected };
};

/** Invented correspondence of one matter, in the order it was sent. */
export const MATTER_CORRESPONDENCE: readonly MailMessage[] = [
  {
    from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
    to: "Jitka Skořepová <skorepova@stavby-hradec.cz>",
    subject: "Spis 23 C 118/2026, podklady k jednání",
    date: "Tue, 17 Nov 2026 09:30:00 +0100",
    body: [
      "Dobrý den, paní Skořepová,",
      "",
      "posílám podklady k jednání dne 3. 12. 2026.",
      "From the court's summons: the hearing starts at 9:00.",
      "",
      "S pozdravem",
      "Ondřej Kalina",
    ].join("\n"),
  },
  {
    from: "Jitka Skořepová <skorepova@stavby-hradec.cz>",
    to: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
    subject: "Re: Spis 23 C 118/2026, podklady k jednání",
    date: "Tue, 17 Nov 2026 14:05:12 +0100",
    body: [
      "Děkuji, potvrzuji účast.",
      "",
      ">From your message: the hearing starts at 9:00.",
      "From now on please write to my colleague as well.",
    ].join("\n"),
    headers: ["X-Gmail-Labels: Spisy/23 C 118-2026,Důležité"],
  },
  {
    from: "JUDr. Tereza Hromádková <hromadkova@ak-kalina-vesela.cz>",
    to: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
    subject: "Vyjádření k žalobě",
    date: "Wed, 18 Nov 2026 08:12:00 +0100",
    body: "Návrh vyjádření je v příloze.",
    headers: ["X-Folder: Spisy/Stavby Hradec"],
  },
];

/**
 * A mailbox whose first message is `bodyBytes` of body long (pass more than
 * one message may be), then `after`: written straight into one buffer, so a
 * test holds the mailbox once rather than as strings and copies.
 */
export const mailboxWithLargeMessage = (
  bodyBytes: number,
  after: Uint8Array = new Uint8Array(),
): Uint8Array => {
  const head = encoder.encode(
    `From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n${new TextDecoder().decode(
      mailMessage({
        ...(MATTER_CORRESPONDENCE[0] ?? panic("The matter has its first message")),
        body: "",
      }),
    )}`,
  );
  const line = encoder.encode("Příloha spisu, strana textu.\n");
  const out = new Uint8Array(head.byteLength + bodyBytes + 1 + after.byteLength);
  out.set(head);
  const bodyStart = head.byteLength;
  // Fill the body with whole lines by doubling what is written so far.
  out.set(line.subarray(0, Math.min(line.byteLength, bodyBytes)), bodyStart);
  let written = Math.min(line.byteLength, bodyBytes);
  while (written < bodyBytes) {
    const copy = Math.min(written, bodyBytes - written);
    out.copyWithin(bodyStart + written, bodyStart, bodyStart + copy);
    written += copy;
  }
  out[bodyStart + bodyBytes - 1] = 0x0a;
  // The blank line a writer puts after every message.
  out[bodyStart + bodyBytes] = 0x0a;
  out.set(after, bodyStart + bodyBytes + 1);
  return out;
};
