import { describe, expect, test } from "bun:test";
import PostalMime from "postal-mime";

import { INBOUND_MAIL_LIMITS } from "./limits";
import type { InboundMessageError } from "./message";
import { parseInboundMessage } from "./message";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(
    await Bun.file(new URL(`fixtures/${name}`, import.meta.url)).arrayBuffer(),
  );

const message = (headers: string, body: string): Uint8Array =>
  bytes(`${headers.replace(/\n/gu, "\r\n")}\r\n\r\n${body}`);

const baseHeaders = [
  "From: Member <member@example.test>",
  "To: Matter <matter@example.test>",
  "Subject: Filed message",
  "Date: Sat, 26 Sep 2026 12:00:00 +0000",
  "Message-ID: <wrapper@example.test>",
].join("\n");

describe("inbound MIME normalization", () => {
  test("keeps a member's CC filing as their own message", async () => {
    const parsed = await parseInboundMessage(await fixture("member-cc.eml"));
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.message.from).toBe("member@example.test");
    expect(parsed.message.cc).toEqual(["matter@example.test"]);
    expect(parsed.message.messageId).toBe("<member-message@example.test>");
  });

  test("extracts the original from an attached email fixture", async () => {
    const parsed = await parseInboundMessage(
      await fixture("attached-forward.eml"),
    );
    expect(parsed.forwardSource).toBe("attached");
    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.message.from).toBe("author@outside.test");
    expect(parsed.message.to).toEqual(["member@example.test"]);
    expect(parsed.message.messageId).toBe("<original@outside.test>");
    expect(parsed.message.text).toBe("Original body.");
  });

  test("extracts a localized inline forward fixture", async () => {
    const parsed = await parseInboundMessage(
      await fixture("inline-forward-cs.eml"),
    );
    expect(parsed.forwardSource).toBe("inline");
    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.message.from).toBe("author@outside.test");
    expect(parsed.message.text).toBe("Original body.");
  });

  test.each([
    [
      "outlook-reply-en.eml",
      "I reject the proposed settlement.",
      "<reply-outlook@example.test>",
    ],
    [
      "outlook-reply-cs.eml",
      "Návrh dohody nepřijímám.",
      "<reply-outlook-cs@example.test>",
    ],
  ])(
    "preserves the reply and quoted original in %s",
    async (name, reply, id) => {
      const parsed = await parseInboundMessage(await fixture(name));
      expect(parsed.forwardSource).toBe("none");
      expect(parsed.message.from).toBe("member@example.test");
      expect(parsed.message.messageId).toBe(id);
      expect(parsed.message.inReplyTo).not.toBeNull();
      expect(parsed.message.references).toHaveLength(1);
      expect(parsed.message.text).toContain(reply);
      expect(parsed.message.text).toContain("counsel@outside.test");
    },
  );

  for (const threadHeader of ["In-Reply-To", "References", "both"]) {
    test.each([
      ["pt-BR", "Rejeito a proposta de acordo."],
      ["hu", "Elutasítom az egyezségi javaslatot."],
      ["nl", "Ik wijs het schikkingsvoorstel af."],
    ])(
      `preserves a localized %s reply with ${threadHeader}`,
      async (locale, reply) => {
        let raw = new TextDecoder().decode(
          await fixture(`threaded-reply-${locale}.eml`),
        );
        if (threadHeader !== "both") {
          raw = raw.replace(
            threadHeader === "In-Reply-To"
              ? /^References:.*\r?\n/mu
              : /^In-Reply-To:.*\r?\n/mu,
            "",
          );
        }
        // The quote is extractable when explicitly forwarded, so this fixture
        // reaches the discrimination boundary rather than an unsupported marker.
        const forwarded = await parseInboundMessage(
          bytes(
            raw.replace(/^Subject:.*$/mu, "Subject: Fwd: Settlement proposal"),
          ),
        );
        expect(forwarded.forwardSource).toBe("inline");
        expect(forwarded.message.from).toBe("counsel@outside.test");

        const parsed = await parseInboundMessage(bytes(raw));
        expect(parsed.forwardSource).toBe("none");
        expect(parsed.message.from).toBe("member@example.test");
        expect(parsed.message.messageId).toBe(`<reply-${locale}@example.test>`);
        expect(parsed.message.text).toContain(reply);
        expect(parsed.message.text).toContain("We propose settlement.");
        expect(parsed.message.inReplyTo).toBe(
          threadHeader === "References" ? null : "<proposal@outside.test>",
        );
        expect(parsed.message.references).toEqual(
          threadHeader === "In-Reply-To" ? [] : ["<proposal@outside.test>"],
        );
      },
    );
  }

  test.each(["In-Reply-To", "References"])(
    "retains an attached original in a prefix-free reply with %s",
    async (threadHeader) => {
      const raw = new TextDecoder().decode(
        await fixture("attached-forward.eml"),
      );
      const parsed = await parseInboundMessage(
        bytes(
          raw.replace(
            "Subject: Fwd: Original subject",
            () =>
              `Subject: Original subject\r\n${threadHeader}: <prior@outside.test>`,
          ),
        ),
      );
      expect(parsed.forwardSource).toBe("none");
      expect(parsed.message.from).toBe("member@example.test");
      expect(parsed.message.messageId).toBe("<forward-wrapper@example.test>");
      expect(parsed.message.text).toContain("Please file this message.");
      expect(parsed.message.attachments).toMatchObject([
        { mimeType: "message/rfc822" },
      ]);
    },
  );

  test.each([
    ["outlook-forward-de.eml", "Vertragsentwurf"],
    ["gmail-forward-en.eml", "Filing deadline"],
    ["apple-forward-fr.eml", "Projet de contrat"],
  ])("extracts the original from %s", async (name, subject) => {
    const parsed = await parseInboundMessage(await fixture(name));
    expect(parsed.forwardSource).toBe("inline");
    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.message.from).toBe("author@outside.test");
    expect(parsed.message.subject).toBe(subject);
    expect(parsed.message.date).toBe("2026-09-25T11:00:00.000Z");
  });

  test("rejects a forged duplicate From fixture", async () => {
    await expect(
      parseInboundMessage(await fixture("forged-from.eml")),
    ).rejects.toMatchObject({
      reason: "invalidFrom",
    } satisfies Partial<InboundMessageError>);
  });

  test("normalizes message metadata and sanitizes active HTML", async () => {
    const raw = message(
      `${baseHeaders}\nCc: Colleague <colleague@example.test>\nIn-Reply-To: <FIRST@EXAMPLE.TEST>\nReferences: <FIRST@EXAMPLE.TEST> <SECOND@example.test>\nContent-Type: text/html; charset=UTF-8`,
      `<p>Hello</p><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">link</a><img src="https://remote.test/pixel">`,
    );
    const parsed = await parseInboundMessage(raw);

    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.to).toEqual(["matter@example.test"]);
    expect(parsed.message.cc).toEqual(["colleague@example.test"]);
    expect(parsed.message.inReplyTo).toBe("<FIRST@example.test>");
    expect(parsed.message.references).toEqual([
      "<FIRST@example.test>",
      "<SECOND@example.test>",
    ]);
    expect(parsed.message.html).toContain("Hello");
    expect(parsed.message.html).not.toMatch(
      /script|javascript:|onclick|https:\/\/remote/u,
    );
    expect(parsed.message.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("extracts one attached RFC 822 message and keeps outer filer separate", async () => {
    const original = message(
      [
        "From: Author <author@outside.test>",
        "To: Member <member@example.test>",
        "Subject: Original subject",
        "Date: Fri, 25 Sep 2026 11:00:00 +0000",
        "Message-ID: <original@outside.test>",
        "Content-Type: multipart/mixed; boundary=inner",
      ].join("\n"),
      [
        "--inner",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Original body",
        "--inner",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="../brief.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQ=",
        "--inner--",
      ].join("\r\n"),
    );
    const raw = message(
      `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
      [
        "--outer",
        "Content-Type: text/plain",
        "",
        "Please file this",
        "--outer",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="forward.eml"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(original).toString("base64"),
        "--outer--",
      ].join("\r\n"),
    );

    const parsed = await parseInboundMessage(raw);
    expect(parsed.outerSender).toBe("member@example.test");
    expect(parsed.forwardSource).toBe("attached");
    expect(parsed.message.from).toBe("author@outside.test");
    expect(parsed.message.subject).toBe("Original subject");
    expect(parsed.message.text).toContain("Original body");
    expect(parsed.message.messageId).toBe("<original@outside.test>");
    expect(parsed.message.attachments).toHaveLength(1);
    expect(parsed.message.attachments[0]?.fileName).toBe("___brief.pdf");
  });

  test.each([
    ["---------- Forwarded message ---------", "From", "Date", "Subject", "To"],
    ["-----Original Message-----", "From", "Sent", "Subject", "To"],
    ["Begin forwarded message:", "From", "Date", "Subject", "To"],
    ["-----Původní zpráva-----", "Od", "Odesláno", "Předmět", "Komu"],
    ["-----Ursprüngliche Nachricht-----", "Von", "Gesendet", "Betreff", "An"],
    ["-----Message transféré-----", "De", "Envoyé", "Objet", "À"],
    ["-----Mensaje reenviado-----", "De", "Enviado", "Asunto", "Para"],
  ])(
    "extracts a forward with localized headers: %s",
    async (marker, from, date, subject, to) => {
      const raw = message(
        baseHeaders.replace(
          "Subject: Filed message",
          () =>
            `Subject: ${/original message|původní zpráva|ursprüngliche nachricht/iu.test(marker) ? "Fwd:" : "Filed message"} Original subject`,
        ),
        [
          "Please file this",
          "",
          marker,
          `${from}: Author <author@outside.test>`,
          `${date}: Fri, 25 Sep 2026 11:00:00 +0000`,
          `${subject}: Original subject`,
          `${to}: Member <member@example.test>`,
          "",
          "Original body",
        ].join("\r\n"),
      );
      const parsed = await parseInboundMessage(raw);
      expect(parsed.forwardSource).toBe("inline");
      expect(parsed.outerSender).toBe("member@example.test");
      expect(parsed.message.from).toBe("author@outside.test");
      expect(parsed.message.subject).toBe("Original subject");
      expect(parsed.message.text).toBe("Original body");
    },
  );

  test("falls back to the member's message for ambiguous inline forwards", async () => {
    const raw = message(
      baseHeaders,
      [
        "-----Original Message-----",
        "From: Author <author@outside.test>",
        "To: Member <member@example.test>",
        "Subject: No date",
        "",
        "Body",
      ].join("\r\n"),
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.from).toBe("member@example.test");
    expect(parsed.message.text).toContain("No date");
  });

  test("keeps a complete ambiguous Outlook quote under its author", async () => {
    const raw = message(
      baseHeaders,
      [
        "Please keep this entire note",
        "",
        "-----Original Message-----",
        "From: Author <author@outside.test>",
        "Sent: Fri, 25 Sep 2026 11:00:00 +0000",
        "To: Member <member@example.test>",
        "Subject: Prior message",
        "",
        "Quoted body",
      ].join("\r\n"),
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.text).toContain("Please keep this entire note");
    expect(parsed.message.text).toContain("Quoted body");
    expect(parsed.message.messageId).toBe("<wrapper@example.test>");
  });

  test("does not extract a quoted Gmail forward from a threaded reply", async () => {
    const raw = message(
      `${baseHeaders.replace(
        "Subject: Filed message",
        "Subject: Re: Filing deadline",
      )}\nIn-Reply-To: <prior@outside.test>\nReferences: <prior@outside.test>`,
      [
        "I object to this deadline.",
        "",
        "---------- Forwarded message ---------",
        "From: Author <author@outside.test>",
        "Date: Fri, 25 Sep 2026 11:00:00 +0000",
        "Subject: Filing deadline",
        "To: Member <member@example.test>",
        "",
        "The filing deadline is 30 September.",
      ].join("\r\n"),
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.from).toBe("member@example.test");
    expect(parsed.message.text).toContain("I object to this deadline.");
    expect(parsed.message.text).toContain(
      "The filing deadline is 30 September.",
    );
    expect(parsed.message.inReplyTo).toBe("<prior@outside.test>");
  });

  test("keeps an inline forward with a timezone-free date under the filer", async () => {
    const raw = message(
      baseHeaders,
      [
        "-----Original Message-----",
        "From: Author <author@outside.test>",
        "Sent: 25/09/2026 11:00",
        "To: Member <member@example.test>",
        "Subject: Original subject",
        "",
        "Original body",
      ].join("\r\n"),
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.from).toBe("member@example.test");
  });

  test("falls back when the only attached message has no valid headers", async () => {
    const raw = message(
      `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
      [
        "--outer",
        "Content-Type: text/plain",
        "",
        "Please file this",
        "--outer",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="message.eml"',
        "",
        "broken message",
        "--outer--",
      ].join("\r\n"),
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.forwardSource).toBe("none");
    expect(parsed.message.from).toBe("member@example.test");
    expect(parsed.message.attachments).toHaveLength(1);
  });

  test("does not let duplicated or multiple outer From mailboxes select a filer", async () => {
    for (const from of [
      "From: member@example.test\nFrom: outsider@outside.test",
      "From: member@example.test, outsider@outside.test",
    ]) {
      const raw = message(
        `${from}\nTo: matter@example.test\nSubject: Test`,
        "Body",
      );
      await expect(parseInboundMessage(raw)).rejects.toMatchObject({
        reason: "invalidFrom",
      } satisfies Partial<InboundMessageError>);
    }
    const absent = await parseInboundMessage(
      message("To: matter@example.test\nSubject: Test", "Body"),
    );
    expect(absent.outerSender).toBeNull();
  });

  test("rejects oversized raw messages and dangerous attachment names", async () => {
    const oversized = new Uint8Array(INBOUND_MAIL_LIMITS.rawBytes + 1);
    await expect(parseInboundMessage(oversized)).rejects.toMatchObject({
      reason: "rawTooLarge",
    } satisfies Partial<InboundMessageError>);

    const raw = message(
      `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
      [
        "--outer",
        "Content-Type: text/plain",
        "",
        "Body",
        "--outer",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="invoice.pdf.exe"',
        "",
        "unsafe",
        "--outer--",
      ].join("\r\n"),
    );
    await expect(parseInboundMessage(raw)).rejects.toMatchObject({
      reason: "unsafeAttachment",
    } satisfies Partial<InboundMessageError>);
  });

  test("enforces decoded attachment and body limits before storage", async () => {
    const hugeAttachment = message(
      `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
      [
        "--outer",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="large.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.alloc(INBOUND_MAIL_LIMITS.attachmentBytes + 1, 0x41).toString(
          "base64",
        ),
        "--outer--",
      ].join("\r\n"),
    );
    await expect(parseInboundMessage(hugeAttachment)).rejects.toMatchObject({
      reason: "attachmentTooLarge",
    } satisfies Partial<InboundMessageError>);

    const hugeBody = message(
      baseHeaders,
      "A".repeat(INBOUND_MAIL_LIMITS.bodyBytes + 1),
    );
    await expect(parseInboundMessage(hugeBody)).rejects.toMatchObject({
      reason: "bodyTooLarge",
    } satisfies Partial<InboundMessageError>);
  });

  test("rejects executable bytes with a harmless filename", async () => {
    const raw = message(
      `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
      [
        "--outer",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="brief.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from([0x4d, 0x5a, 0, 0]).toString("base64"),
        "--outer--",
      ].join("\r\n"),
    );
    await expect(parseInboundMessage(raw)).rejects.toMatchObject({
      reason: "unsafeAttachment",
    } satisfies Partial<InboundMessageError>);
  });

  test("content identity excludes the forwarding wrapper", async () => {
    const forwarded = (preface: string) =>
      message(
        baseHeaders,
        [
          preface,
          "",
          "---------- Forwarded message ---------",
          "From: Author <author@outside.test>",
          "Date: Fri, 25 Sep 2026 11:00:00 +0000",
          "Subject: Original subject",
          "To: Member <member@example.test>",
          "",
          "Original body",
        ].join("\r\n"),
      );
    const first = await parseInboundMessage(forwarded("Please file"));
    const second = await parseInboundMessage(forwarded("FYI"));
    expect(first.message.contentHash).toBe(second.message.contentHash);
  });

  test("two filers forwarding the same attached message yield one content identity", async () => {
    const original = message(
      [
        "From: Author <author@outside.test>",
        "To: Member <member@example.test>",
        "Subject: Original subject",
        "Date: Fri, 25 Sep 2026 11:00:00 +0000",
        "Message-ID: <CaseSensitive@OUTSIDE.TEST>",
        "Content-Type: text/plain",
      ].join("\n"),
      "Original body",
    );
    const wrapper = (filer: string, subject: string) =>
      message(
        [
          `From: ${filer}`,
          "To: Matter <matter@example.test>",
          `Subject: ${subject}`,
          "Content-Type: multipart/mixed; boundary=outer",
        ].join("\n"),
        [
          "--outer",
          "Content-Type: message/rfc822",
          'Content-Disposition: attachment; filename="original.eml"',
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(original).toString("base64"),
          "--outer--",
        ].join("\r\n"),
      );
    const first = await parseInboundMessage(
      wrapper("member@example.test", "First wrapper"),
    );
    const second = await parseInboundMessage(
      wrapper("colleague@example.test", "Second wrapper"),
    );
    expect(first.forwardSource).toBe("attached");
    expect(second.forwardSource).toBe("attached");
    expect(first.outerSender).not.toBe(second.outerSender);
    expect(first.message.messageId).toBe("<CaseSensitive@outside.test>");
    expect(first.message.contentHash).toBe(second.message.contentHash);
  });

  test("content identity canonicalizes explicit dates and unordered participants", async () => {
    const one = message(
      [
        "From: author@outside.test",
        "To: one@example.test, two@example.test",
        "Cc: three@example.test, four@example.test",
        "Date: Fri, 25 Sep 2026 11:00:00 +0000",
        "Subject: Update",
        "Content-Type: text/plain",
      ].join("\n"),
      "Same body",
    );
    const two = message(
      [
        "From: author@outside.test",
        "To: two@example.test, one@example.test",
        "Cc: four@example.test, three@example.test",
        "Date: Fri, 25 Sep 2026 13:00:00 +0200",
        "Subject: Update",
        "Content-Type: text/plain",
      ].join("\n"),
      "Same body",
    );
    const first = await parseInboundMessage(one);
    const second = await parseInboundMessage(two);
    expect(first.message.date).toBe("2026-09-25T11:00:00.000Z");
    expect(second.message.date).toBe(first.message.date);
    expect(first.message.to).not.toEqual(second.message.to);
    expect(first.message.contentHash).toBe(second.message.contentHash);
  });

  test.each([
    "not-a-date",
    "Fri, 25 Sep 2026 11:00:00",
    "2026-09-25T11:00:00",
    "Fri, 31 Feb 2026 11:00:00 +0000",
    "2026-02-31T11:00:00Z",
    "Fri, 25 Sep 2026 11:00:00 +0060",
    "Fri, 25 Sep 2026 11:00:00 +2400",
    "Fri, 25 Sep 2026 11:00:00 -0000",
  ])("treats invalid or zone-free raw Date as absent: %s", async (date) => {
    const raw = message(
      baseHeaders.replace("Sat, 26 Sep 2026 12:00:00 +0000", () => date),
      "Body",
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.message.date).toBeNull();
  });

  test("reads Date from the raw header before PostalMime's host-dependent conversion", async () => {
    const noZone = message(
      baseHeaders.replace(
        "Sat, 26 Sep 2026 12:00:00 +0000",
        "Sat, 26 Sep 2026 12:00:00",
      ),
      "Body",
    );
    const withoutDate = message(
      baseHeaders.replace("Date: Sat, 26 Sep 2026 12:00:00 +0000\n", ""),
      "Body",
    );
    const first = await parseInboundMessage(noZone);
    const second = await parseInboundMessage(withoutDate);
    expect(first.message.date).toBeNull();
    expect(first.message.contentHash).toBe(second.message.contentHash);
  });

  test("normalizes an explicitly zoned raw Date with a trailing comment", async () => {
    const raw = message(
      baseHeaders.replace(
        "Sat, 26 Sep 2026 12:00:00 +0000",
        "Sat, 26 Sep 2026 14:00:00 +0200 (CEST)",
      ),
      "Body",
    );
    const parsed = await parseInboundMessage(raw);
    expect(parsed.message.date).toBe("2026-09-26T12:00:00.000Z");
  });

  test("date storage and content identity stay stable across host timezones", async () => {
    const previousTimezone = process.env.TZ;
    const ambiguous = message(
      baseHeaders.replace("12:00:00 +0000", "12:00:00"),
      "Body",
    );
    const zoned = message(
      baseHeaders.replace("12:00:00 +0000", "14:00:00 +0200"),
      "Body",
    );
    const identities = new Set<string>();
    const providerDates = new Set<string | undefined>();
    try {
      for (const timezone of [
        "UTC",
        "America/Los_Angeles",
        "Pacific/Auckland",
      ]) {
        process.env.TZ = timezone;
        providerDates.add((await PostalMime.parse(ambiguous)).date);
        const withoutZone = await parseInboundMessage(ambiguous);
        const withZone = await parseInboundMessage(zoned);
        expect(withoutZone.message.date).toBeNull();
        expect(withZone.message.date).toBe("2026-09-26T12:00:00.000Z");
        identities.add(
          JSON.stringify([
            withoutZone.message.contentHash,
            withZone.message.contentHash,
          ]),
        );
      }
    } finally {
      // Bun's date cache needs a reassignment when restoring an unset TZ.
      process.env.TZ = previousTimezone ?? "";
    }
    expect(providerDates.size).toBeGreaterThan(1);
    expect(identities.size).toBe(1);
  });

  test("content identity ignores attachment order and transport filenames", async () => {
    const attachment = (fileName: string, content: string) =>
      [
        "--outer",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment; filename="${fileName}"`,
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(content).toString("base64"),
      ].join("\r\n");
    const email = (parts: string[]) =>
      message(
        `${baseHeaders}\nContent-Type: multipart/mixed; boundary=outer`,
        [
          "--outer",
          "Content-Type: text/plain",
          "",
          "Original body",
          ...parts,
          "--outer--",
        ].join("\r\n"),
      );
    const first = await parseInboundMessage(
      email([
        attachment("first.pdf", "first"),
        attachment("second.pdf", "second"),
      ]),
    );
    const second = await parseInboundMessage(
      email([
        attachment("renamed-second.pdf", "second"),
        attachment("renamed-first.pdf", "first"),
      ]),
    );
    expect(
      first.message.attachments.map(({ fileName }) => fileName),
    ).not.toEqual(second.message.attachments.map(({ fileName }) => fileName));
    expect(first.message.contentHash).toBe(second.message.contentHash);
  });
});
