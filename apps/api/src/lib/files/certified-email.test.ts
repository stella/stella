import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import PostalMime from "postal-mime";

import { assertProperty } from "@stll/property-testing";

import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  PEC_FIXTURE,
  PEC_SIGNER_NAME,
  pecDaticert,
  pecDeliveryReceipt,
  pecMessage,
  pecOriginalMessage,
} from "@/api/tests/fixtures/pec";

import {
  CERTIFIED_EMAIL_LIMITS,
  mayBeCertificationData,
  readCertificationData,
} from "./certified-email";
import {
  buildEmailPreview,
  parsedEmailToText,
  parseEmail,
} from "./email-to-html";

const EML = "message/rfc822";

const codeOf = (character: string) => character.codePointAt(0) ?? 0;

/** XML 1.0 characters: tab, line feed and carriage return are its only controls. */
const isXmlCharacter = (character: string) => {
  const code = codeOf(character);
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7_ff) ||
    (code >= 0xe0_00 && code <= 0xff_fd) ||
    code >= 0x1_00_00
  );
};

const isControlCharacter = (character: string) => {
  const code = codeOf(character);
  return code < 0x20 || code === 0x7f;
};
const encode = (text: string) => new TextEncoder().encode(text);

const parse = async (bytes: Uint8Array) => {
  const parsed = await parseEmail(bytes.slice().buffer, EML);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  return parsed.value;
};

const attachmentNames = (parsed: Awaited<ReturnType<typeof parse>>) =>
  parsed.attachments.map(({ fileName }) => fileName);

describe("a PEC transport envelope", () => {
  test.each(["inline", "attachment"] as const)(
    "reads as its original message with the certification data beside it (original %s)",
    async (originalDisposition) => {
      const parsed = await parse(await pecMessage({ originalDisposition }));
      expect(parsed.subject).toBe(PEC_FIXTURE.subject);
      expect(parsed.from).toContain(PEC_FIXTURE.sender);
      expect(parsed.cc).toEqual([PEC_FIXTURE.externalRecipient]);
      expect(parsed.body).toMatchObject({ type: "text" });
      expect(parsedEmailToText(parsed)).toContain(PEC_FIXTURE.body);
      // Only the original's own attachment is listed; the provider's parts
      // (its text, the certification data, its signature) are the envelope.
      expect(attachmentNames(parsed)).toEqual([PEC_FIXTURE.attachmentName]);
      expect(parsed.certified).toEqual({
        system: "pec",
        kind: "transport",
        error: "none",
        errorDetail: null,
        sender: PEC_FIXTURE.sender,
        recipients: [
          { address: PEC_FIXTURE.certifiedRecipient, certified: true },
          { address: PEC_FIXTURE.externalRecipient, certified: false },
        ],
        replyTo: PEC_FIXTURE.sender,
        subject: PEC_FIXTURE.subject,
        provider: PEC_FIXTURE.provider,
        // 10:15:30 at +0100 is 09:15:30 UTC.
        certifiedAt: "2026-11-21T09:15:30.000Z",
        messageId: PEC_FIXTURE.messageId,
        originalMessageId: PEC_FIXTURE.originalMessageId,
        receiptType: "full",
        deliveredTo: null,
        receivedFor: [],
        includesOriginal: true,
        signature: {
          status: "unverified",
          signerName: PEC_SIGNER_NAME,
          issuerName: PEC_SIGNER_NAME,
          serialNumber: "01",
          signedAt: null,
        },
      });
    },
  );

  test("reads an original that the inline parse of the whole file refuses", async () => {
    // More addresses than PostalMime reads from one forwarded message.
    const recipients = Array.from(
      { length: 10_001 },
      (_, index) => `r${String(index)}@example.com`,
    ).join(", ");
    const original = pecOriginalMessage().replace(
      `To: ${PEC_FIXTURE.certifiedRecipient}`,
      () => `To: ${recipients}`,
    );
    const bytes = await pecMessage({ original });
    // Without the certified reading the file does not parse at all.
    const inline = await new PostalMime().parse(bytes.slice().buffer).then(
      () => "parsed",
      () => "refused",
    );
    expect(inline).toBe("refused");
    const parsed = await parse(bytes);
    expect(parsed.certified?.includesOriginal).toBe(true);
    expect(parsed.subject).toBe(PEC_FIXTURE.subject);
    expect(parsed.to).toHaveLength(10_001);
  });

  test("is recognised by its content, whatever its parts are named", async () => {
    const parsed = await parse(
      await pecMessage({ daticertName: "renamed-data.bin" }),
    );
    expect(parsed.certified?.kind).toBe("transport");
    expect(attachmentNames(parsed)).toEqual([PEC_FIXTURE.attachmentName]);
  });

  test("keeps a provider's extra parts listed beside the original's", async () => {
    const parsed = await parse(
      await pecMessage({
        extraParts: [
          { name: "nota.txt", mimeType: "text/plain", content: "Nota" },
        ],
      }),
    );
    expect(parsed.certified?.includesOriginal).toBe(true);
    expect(attachmentNames(parsed)).toEqual([
      PEC_FIXTURE.attachmentName,
      "nota.txt",
    ]);
  });

  test("the preview lists exactly the attachments the reader holds", async () => {
    const parsed = await parse(await pecMessage());
    const preview = buildEmailPreview(parsed);
    expect(preview.certified).toEqual(parsed.certified);
    expect(preview.attachments.map(({ fileName }) => fileName)).toEqual(
      attachmentNames(parsed),
    );
  });

  test("states its certification data in the text search, chat and agents read", async () => {
    const text = parsedEmailToText(await parse(await pecMessage()));
    for (const expected of [
      "Italian certified email (PEC) as stated in the file, not verified: transport envelope",
      `Stated sender: ${PEC_FIXTURE.sender}`,
      `Stated recipient: ${PEC_FIXTURE.externalRecipient} (ordinary mailbox)`,
      "Certified at: 2026-11-21T09:15:30.000Z",
      `PEC message ID: ${PEC_FIXTURE.messageId}`,
      "Provider signature: unverified",
      `Stated signer: ${PEC_SIGNER_NAME}`,
      PEC_FIXTURE.body,
    ]) {
      expect(text).toContain(expected);
    }
    expect(text.indexOf("Italian certified email")).toBeLessThan(
      text.indexOf(PEC_FIXTURE.body),
    );
  });
});

describe("PEC receipts and notices", () => {
  test.each([
    ["completa", "full", [PEC_FIXTURE.attachmentName], true],
    ["breve", "short", [PEC_FIXTURE.attachmentName], true],
    ["sintetica", "summary", [], false],
  ] as const)(
    "a %s delivery receipt reads with what it carries",
    async (receipt, receiptType, names, includesOriginal) => {
      const parsed = await parse(await pecDeliveryReceipt(receipt));
      expect(parsed.certified).toMatchObject({
        kind: "delivery",
        receiptType,
        deliveredTo: PEC_FIXTURE.certifiedRecipient,
        includesOriginal,
      });
      expect(attachmentNames(parsed)).toEqual([...names]);
      expect(parsedEmailToText(parsed)).toContain(
        includesOriginal ? PEC_FIXTURE.body : "Ricevuta di avvenuta consegna",
      );
    },
  );

  test("a non-delivery notice states the error and the provider's detail", async () => {
    const parsed = await parse(
      await pecMessage({
        providerHeader: ["X-Ricevuta", "errore-consegna"],
        subjectPrefix: "AVVISO DI MANCATA CONSEGNA: ",
        notice: "Avviso di mancata consegna",
        daticert: pecDaticert({
          type: "errore-consegna",
          error: "no-dest",
          receipt: null,
          deliveredTo: PEC_FIXTURE.certifiedRecipient,
          errorDetail: "5.1.1 - Utente non riconosciuto",
        }),
        original: null,
      }),
    );
    expect(parsed.subject).toContain("AVVISO DI MANCATA CONSEGNA");
    expect(attachmentNames(parsed)).toEqual([]);
    expect(parsed.certified).toMatchObject({
      kind: "delivery_error",
      error: "no_recipient",
      errorDetail: "5.1.1 - Utente non riconosciuto",
      receiptType: null,
      includesOriginal: false,
    });
  });
});

describe("what is not a PEC message", () => {
  test("certification data in an ordinary email leaves it an ordinary email", async () => {
    const parsed = await parse(
      await pecMessage({ providerHeader: null, signed: false }),
    );
    expect(parsed.certified).toBeNull();
    expect(attachmentNames(parsed)).toContain("daticert.xml");
  });

  test("an unsigned message with a provider header reads as an ordinary email", async () => {
    const parsed = await parse(await pecMessage({ signed: false }));
    expect(parsed.certified).toBeNull();
    expect(attachmentNames(parsed)).toContain("daticert.xml");
  });

  test.each([
    ["an unknown message type", pecDaticert({ type: "inventato" })],
    ["an unknown error", pecDaticert({ error: "inventato" })],
    ["another root element", "<dati><identificativo>x</identificativo></dati>"],
    [
      "an internal document type subset",
      pecDaticert({
        doctype: '<!DOCTYPE postacert [<!ENTITY x "y">]>',
      }),
    ],
    ["malformed XML", "<postacert tipo='posta-certificata'><intestazione>"],
  ])(
    "a provider header with %s reads as an ordinary email",
    async (_, daticert) => {
      const parsed = await parse(await pecMessage({ daticert }));
      expect(parsed.certified).toBeNull();
    },
  );

  test("a second part that only looks like certification data is ambiguous too", async () => {
    const parsed = await parse(
      await pecMessage({
        extraParts: [
          {
            name: "altro.xml",
            mimeType: "application/xml",
            content: pecDaticert({ type: "inventato" }),
          },
        ],
      }),
    );
    expect(parsed.certified).toBeNull();
  });

  test("a signed document beside the message is not the provider's signature", async () => {
    const parsed = await parse(
      await pecMessage({
        signed: false,
        extraParts: [
          {
            name: "relazione.pdf.p7m",
            mimeType: "application/pkcs7-mime",
            content: await wrapP7m(new TextEncoder().encode("relazione")),
          },
        ],
      }),
    );
    expect(parsed.certified).toBeNull();
    expect(attachmentNames(parsed)).toContain("relazione.pdf.p7m");
  });

  test("two certification data parts are ambiguous and read as an ordinary email", async () => {
    const parsed = await parse(
      await pecMessage({
        extraParts: [
          {
            name: "copia.xml",
            mimeType: "application/xml",
            content: pecDaticert(),
          },
        ],
      }),
    );
    expect(parsed.certified).toBeNull();
  });

  test("an ordinary email forwarding a message inline keeps its attachments and their charsets", async () => {
    const forwarded = pecOriginalMessage().replace(
      `Content-Type: text/plain; name="${PEC_FIXTURE.attachmentName}"`,
      () =>
        `Content-Type: text/plain; charset="windows-1250"; name="${PEC_FIXTURE.attachmentName}"`,
    );
    const parsed = await parse(
      encode(
        [
          "From: studio@example.com",
          "To: cliente@example.com",
          "Subject: Fwd: atto",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="outer"',
          "",
          "--outer",
          "Content-Type: text/plain",
          "",
          "In allegato.",
          "--outer",
          "Content-Type: message/rfc822",
          "Content-Disposition: inline",
          "",
          forwarded,
          "--outer--",
          "",
        ].join("\r\n"),
      ),
    );
    expect(parsed.certified).toBeNull();
    expect(
      parsed.attachments.map(({ fileName, charset }) => [fileName, charset]),
    ).toEqual([[PEC_FIXTURE.attachmentName, "windows-1250"]]);
  });

  test("an ordinary email is read exactly as before", async () => {
    const parsed = await parse(encode(pecOriginalMessage()));
    expect(parsed.certified).toBeNull();
    expect(parsed.subject).toBe(PEC_FIXTURE.subject);
    expect(attachmentNames(parsed)).toEqual([PEC_FIXTURE.attachmentName]);
  });
});

describe("certification data", () => {
  const read = (xml: string) => readCertificationData(encode(xml));

  test.each([
    ["10:15:30", "-0330", "21/11/2026", "2026-11-21T13:45:30.000Z"],
    ["23:59:59", "+0000", "29/02/2028", "2028-02-29T23:59:59.000Z"],
    // An impossible day or time is not a timestamp; Date would roll it over.
    ["10:15:30", "+0100", "31/02/2026", null],
    ["24:00:00", "+0100", "21/11/2026", null],
    ["10:15:30", "0100", "21/11/2026", null],
  ])("reads %s at %s on %s as %s", (time, zone, day, expected) => {
    expect(read(pecDaticert({ time, zone, day }))?.certifiedAt).toBe(expected);
  });

  test("accepts a document type that only names the DTD", () => {
    expect(
      read(
        pecDaticert({ doctype: '<!DOCTYPE postacert SYSTEM "postacert.dtd">' }),
      )?.kind,
    ).toBe("transport");
  });

  test("reads a part that declares Latin-1", () => {
    const xml = pecDaticert().replace(
      /encoding="[^"]*"/u,
      () => 'encoding="ISO-8859-1"',
    );
    const bytes = Buffer.from(xml.replace("Notifica", "Notificà"), "latin1");
    expect(readCertificationData(new Uint8Array(bytes))?.subject).toBe(
      `Notificà atto di citazione`,
    );
  });

  test("refuses more recipients than the limit", () => {
    const extraRecipients = Array.from(
      { length: CERTIFIED_EMAIL_LIMITS.maxRecipients },
      (_, index) => `r${String(index)}@pec.example.com`,
    );
    expect(read(pecDaticert({ extraRecipients }))).toBeNull();
  });

  test("only a part that begins as certification data is parsed", () => {
    expect(mayBeCertificationData(encode(pecDaticert()))).toBe(true);
    expect(mayBeCertificationData(encode("<postacerts/>"))).toBe(false);
    expect(
      mayBeCertificationData(
        encode(pecDaticert().padEnd(CERTIFIED_EMAIL_LIMITS.maxDataBytes + 1)),
      ),
    ).toBe(false);
  });

  test("every stated field is one bounded line of text", () => {
    const escape = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    assertProperty(
      "every stated field is one bounded line of text",
      fc.property(fc.string({ unit: "binary", maxLength: 9000 }), (value) => {
        const text = escape(Array.from(value).filter(isXmlCharacter).join(""));
        const data = read(
          pecDaticert().replace(
            `<oggetto>${PEC_FIXTURE.subject}</oggetto>`,
            () => `<oggetto>${text}</oggetto>`,
          ),
        );
        expect(data).not.toBeNull();
        const subject = data?.subject ?? "";
        expect(subject.length).toBeLessThanOrEqual(
          CERTIFIED_EMAIL_LIMITS.maxFieldCharacters,
        );
        expect(Array.from(subject).some(isControlCharacter)).toBe(false);
        expect(subject).toBe(subject.trim());
      }),
      { numRuns: 200 },
    );
  });
});
