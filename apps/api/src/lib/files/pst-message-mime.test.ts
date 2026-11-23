import { describe, expect, test } from "bun:test";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import type { PstAttachment } from "@stll/pst-reader";

import {
  pstMessage,
  pstProperties,
  uncompressedRtf,
} from "@/api/tests/fixtures/pst";

import { parseEmail } from "./email-to-html";
import { PST_PROPERTY, pstMessageEmail } from "./pst-message-mime";

const { binary, boolean, integer32, string8, time, unicode } = pstProperties;

const parse = async (bytes: Uint8Array) =>
  (await parseEmail(bytes.slice().buffer, EML_MIME_TYPE)).unwrap();

const SENT = new Date("2026-11-17T08:30:00Z");

const header = [
  unicode(PST_PROPERTY.subject, "Spis 23 C 118/2026: podklady"),
  unicode(PST_PROPERTY.senderName, "Petra Vlková"),
  unicode(PST_PROPERTY.senderSmtpAddress, "petra.vlkova@vlkova-lisy.example"),
  time(PST_PROPERTY.clientSubmitTime, SENT),
];

const recipient = (type: number, name: string, address: string) => [
  integer32(PST_PROPERTY.recipientType, type),
  unicode(PST_PROPERTY.displayName, name),
  unicode(PST_PROPERTY.addressType, "SMTP"),
  unicode(PST_PROPERTY.smtpAddress, address),
];

const attachment = (
  name: string,
  content: PstAttachment["content"],
  more: ReturnType<typeof unicode>[] = [],
): PstAttachment => ({
  properties: [
    unicode(PST_PROPERTY.attachLongFilename, name),
    integer32(PST_PROPERTY.attachMethod, 1),
    ...more,
  ],
  content,
});

describe("pstMessageEmail", () => {
  test("writes the sender, recipients, date, subject and ids as headers", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage(
          [
            ...header,
            unicode(PST_PROPERTY.body, "Dobrý den, posílám podklady."),
            unicode(
              PST_PROPERTY.internetMessageId,
              "<podklady-1@vlkova-lisy.example>",
            ),
            unicode(
              PST_PROPERTY.inReplyToId,
              "<dotaz@fiktivni-stavby.example>",
            ),
          ],
          {
            recipients: [
              recipient(1, "Ondřej Lisý", "ondrej.lisy@vlkova-lisy.example"),
              recipient(2, "Jitka Fiktivní", "jitka@fiktivni-stavby.example"),
              recipient(3, "Archiv", "archiv@vlkova-lisy.example"),
            ],
          },
        ),
      ),
    );
    expect(email).toMatchObject({
      subject: "Spis 23 C 118/2026: podklady",
      from: "Petra Vlková <petra.vlkova@vlkova-lisy.example>",
      to: ["Ondřej Lisý <ondrej.lisy@vlkova-lisy.example>"],
      cc: ["Jitka Fiktivní <jitka@fiktivni-stavby.example>"],
      bcc: ["Archiv <archiv@vlkova-lisy.example>"],
      body: { type: "text", text: "Dobrý den, posílám podklady." },
    });
    expect(new Date(email.date ?? "").toISOString()).toBe(SENT.toISOString());
  });

  test("the email is plain ASCII whatever the message holds", () => {
    const bytes = pstMessageEmail(
      pstMessage([
        ...header,
        unicode(PST_PROPERTY.subject, "Ελληνικά, العربية, 日本語 😀"),
        unicode(PST_PROPERTY.body, "Žluťoučký kůň"),
      ]),
    );
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
  });

  test("a sender or recipient without an SMTP address keeps the name", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage(
          [
            unicode(PST_PROPERTY.senderName, "Recepce"),
            unicode(PST_PROPERTY.senderAddressType, "EX"),
            unicode(
              PST_PROPERTY.senderEmail,
              "/O=FIRMA/OU=EXCHANGE/CN=RECIPIENTS/CN=RECEPCE",
            ),
            unicode(PST_PROPERTY.body, "Text"),
          ],
          {
            recipients: [
              [
                integer32(PST_PROPERTY.recipientType, 1),
                unicode(PST_PROPERTY.displayName, "Spisovna"),
                unicode(PST_PROPERTY.addressType, "EX"),
                unicode(PST_PROPERTY.emailAddress, "/O=FIRMA/CN=SPISOVNA"),
              ],
            ],
          },
        ),
      ),
    );
    expect(email.from).toBe("Recepce");
    expect(email.to).toEqual(["Spisovna"]);
  });

  test("names recipients from the display fields when it has no recipient table", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          ...header,
          unicode(PST_PROPERTY.displayTo, "Ondřej Lisý; Jitka Fiktivní"),
          unicode(PST_PROPERTY.body, "Text"),
        ]),
      ),
    );
    expect(email.to).toEqual(["Ondřej Lisý", "Jitka Fiktivní"]);
  });

  test("a subject's prefix marker is not text", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          unicode(PST_PROPERTY.subject, "\u0001\u0004RE: Termín jednání"),
          unicode(PST_PROPERTY.body, "Text"),
        ]),
      ),
    );
    expect(email.subject).toBe("RE: Termín jednání");
  });

  test("reads 8-bit strings in the message's code page", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          integer32(PST_PROPERTY.messageCodePage, 1250),
          // "Žaloba" in Windows-1250.
          string8(
            PST_PROPERTY.subject,
            Uint8Array.of(0x8e, 0x61, 0x6c, 0x6f, 0x62, 0x61),
          ),
          string8(
            PST_PROPERTY.body,
            Uint8Array.of(0x9e, 0x61, 0x6c, 0x6f, 0x62, 0x61),
          ),
        ]),
      ),
    );
    expect(email.subject).toBe("Žaloba");
    expect(email.body).toEqual({ type: "text", text: "žaloba" });
  });

  test("writes the plain and HTML bodies as alternatives", async () => {
    const bytes = pstMessageEmail(
      pstMessage([
        ...header,
        unicode(PST_PROPERTY.body, "Návrh smlouvy"),
        binary(
          PST_PROPERTY.html,
          new TextEncoder().encode("<p>Návrh <b>smlouvy</b></p>"),
        ),
        integer32(PST_PROPERTY.internetCodePage, 65_001),
      ]),
    );
    expect(new TextDecoder().decode(bytes)).toContain("multipart/alternative");
    const email = await parse(bytes);
    expect(email.body.type).toBe("html");
    expect(email.body.type === "html" ? email.body.html : "").toContain(
      "<b>smlouvy</b>",
    );
  });

  test("an RTF body carrying HTML is shown as that HTML", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          ...header,
          binary(
            PST_PROPERTY.rtfCompressed,
            uncompressedRtf(
              "{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag19 <html>}{\\*\\htmltag64 <p>}Z\\'e1pis z porady{\\*\\htmltag72 </p>}{\\*\\htmltag27 </html>}}",
            ),
          ),
        ]),
      ),
    );
    expect(email.body.type).toBe("html");
    expect(email.body.type === "html" ? email.body.html : "").toContain(
      "Zápis z porady",
    );
  });

  test("a plain RTF body is its text", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          ...header,
          binary(
            PST_PROPERTY.rtfCompressed,
            uncompressedRtf(
              "{\\rtf1\\ansi\\deff0 Plnou moc jsem nechal podepsat.\\par}",
            ),
          ),
        ]),
      ),
    );
    expect(email.body).toEqual({
      type: "text",
      text: "Plnou moc jsem nechal podepsat.",
    });
  });

  test("a damaged RTF body leaves the message without one", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          ...header,
          binary(PST_PROPERTY.rtfCompressed, Uint8Array.of(1, 2, 3)),
        ]),
      ),
    );
    expect(email.body).toEqual({ type: "text", text: "" });
  });

  test("writes attachments under their names, inline images by their ids", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 návrh");
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const email = await parse(
      pstMessageEmail(
        pstMessage(
          [
            ...header,
            binary(
              PST_PROPERTY.html,
              new TextEncoder().encode('<p><img src="cid:logo@vlkova"></p>'),
            ),
          ],
          {
            attachments: [
              attachment("návrh smlouvy.pdf", pdf, [
                unicode(PST_PROPERTY.attachMimeTag, "application/pdf"),
              ]),
              {
                properties: [
                  unicode(PST_PROPERTY.attachLongFilename, "logo.png"),
                  unicode(PST_PROPERTY.attachMimeTag, "image/png"),
                  unicode(PST_PROPERTY.attachContentId, "logo@vlkova"),
                  boolean(PST_PROPERTY.attachmentHidden, true),
                ],
                content: png,
              },
            ],
          },
        ),
      ),
    );
    expect(
      email.attachments.map(({ fileName, mimeType, contentId, bytes }) => ({
        fileName,
        mimeType,
        contentId,
        size: bytes.byteLength,
      })),
    ).toEqual([
      {
        fileName: "návrh smlouvy.pdf",
        mimeType: "application/pdf",
        contentId: null,
        size: pdf.byteLength,
      },
      expect.objectContaining({
        fileName: "logo.png",
        mimeType: "image/png",
        size: png.byteLength,
      }),
    ]);
  });

  test("an attachment whose content is not read is an empty one under its name", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([...header, unicode(PST_PROPERTY.body, "Text")], {
          attachments: [
            {
              properties: [
                unicode(PST_PROPERTY.attachFilename, "Výzva k úhradě.msg"),
                integer32(PST_PROPERTY.attachMethod, 5),
              ],
              content: null,
            },
          ],
        }),
      ),
    );
    expect(
      email.attachments.map(({ fileName, bytes }) => [
        fileName,
        bytes.byteLength,
      ]),
    ).toEqual([["Výzva k úhradě.eml", 0]]);
  });

  test("an attached message is a nested email with its own attachments", async () => {
    const nested = pstMessage(
      [
        unicode(PST_PROPERTY.subject, "Výzva k úhradě"),
        unicode(PST_PROPERTY.senderName, "Podatelna"),
        unicode(PST_PROPERTY.senderSmtpAddress, "podatelna@modry-dub.example"),
        unicode(PST_PROPERTY.body, "Vyzýváme Vás k úhradě."),
      ],
      {
        attachments: [
          attachment("faktura.pdf", new TextEncoder().encode("%PDF-1.4")),
        ],
      },
    );
    const bytes = pstMessageEmail(
      pstMessage([...header, unicode(PST_PROPERTY.body, "Přeposílám")], {
        attachments: [
          {
            properties: [
              unicode(PST_PROPERTY.attachLongFilename, "Výzva k úhradě.msg"),
              integer32(PST_PROPERTY.attachMethod, 5),
            ],
            content: nested,
          },
        ],
      }),
    );
    const email = await parse(bytes);
    const [message] = email.attachments;
    expect(message?.fileName).toBe("Výzva k úhradě.eml");
    const inner = await parse(message?.bytes ?? new Uint8Array());
    expect(inner).toMatchObject({
      subject: "Výzva k úhradě",
      from: "Podatelna <podatelna@modry-dub.example>",
      body: { type: "text", text: "Vyzýváme Vás k úhradě." },
    });
    expect(inner.attachments.map(({ fileName }) => fileName)).toEqual([
      "faktura.pdf",
    ]);
  });

  test("a header value never ends its header", async () => {
    const email = await parse(
      pstMessageEmail(
        pstMessage([
          unicode(PST_PROPERTY.subject, "Spis\r\nBcc: unikly@example.example"),
          unicode(
            PST_PROPERTY.internetMessageId,
            "<a@b>\r\nBcc: x@example.example",
          ),
          unicode(PST_PROPERTY.body, "Text"),
        ]),
      ),
    );
    expect(email.subject).toBe("Spis Bcc: unikly@example.example");
    expect(email.bcc).toEqual([]);
  });
});
