/**
 * Synthetic Italian PEC messages in the shape the AgID technical rules give
 * them (DM 2 November 2005, annex 6.1, 6.3.4, 6.5.2 and 7.4): an S/MIME
 * `multipart/signed` provider message whose signed part holds the provider's
 * text, the certification data and, when it carries one, the original
 * message. Every address, name and identifier is invented.
 */
import { wrapP7m } from "@/api/tests/fixtures/p7m";

export const PEC_FIXTURE = {
  sender: "mittente@pec.example.com",
  certifiedRecipient: "destinatario@pec.example.com",
  externalRecipient: "ufficio@example.org",
  provider: "Example PEC provider",
  messageId: "opec-fixture.20261121101530.00001.01.1.1@pec.example.com",
  originalMessageId: "<original-fixture@example.com>",
  subject: "Notifica atto di citazione",
  body: "Si trasmette in allegato l'atto di citazione.",
  attachmentName: "atto-di-citazione.txt",
  attachmentText: "Atto di citazione: testo di prova.",
} as const;

/** The provider's signature part: a detached SignedData by a throwaway key. */
export const PEC_SIGNER_NAME = "Example first signer";

const CRLF = "\r\n";

const base64Lines = (bytes: Uint8Array | string) =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/gu) ?? []
  ).join(CRLF);

type DaticertOptions = {
  type?: string;
  error?: string;
  receipt?: string | null;
  deliveredTo?: string | null;
  errorDetail?: string | null;
  day?: string;
  time?: string;
  zone?: string;
  extraRecipients?: readonly string[];
  doctype?: string;
};

export const pecDaticert = ({
  type = "posta-certificata",
  error = "nessuno",
  receipt = "completa",
  deliveredTo = null,
  errorDetail = null,
  day = "21/11/2026",
  time = "10:15:30",
  zone = "+0100",
  extraRecipients = [],
  doctype = "",
}: DaticertOptions = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    doctype,
    `<postacert tipo="${type}" errore="${error}">`,
    "<intestazione>",
    `<mittente>${PEC_FIXTURE.sender}</mittente>`,
    `<destinatari tipo="certificato">${PEC_FIXTURE.certifiedRecipient}</destinatari>`,
    `<destinatari tipo="esterno">${PEC_FIXTURE.externalRecipient}</destinatari>`,
    ...extraRecipients.map(
      (address) => `<destinatari tipo="certificato">${address}</destinatari>`,
    ),
    `<risposte>${PEC_FIXTURE.sender}</risposte>`,
    `<oggetto>${PEC_FIXTURE.subject}</oggetto>`,
    "</intestazione>",
    "<dati>",
    `<gestore-emittente>${PEC_FIXTURE.provider}</gestore-emittente>`,
    `<data zona="${zone}"><giorno>${day}</giorno><ora>${time}</ora></data>`,
    `<identificativo>${PEC_FIXTURE.messageId}</identificativo>`,
    `<msgid>${PEC_FIXTURE.originalMessageId.replace("<", "&lt;").replace(">", "&gt;")}</msgid>`,
    ...(receipt === null ? [] : [`<ricevuta tipo="${receipt}"/>`]),
    ...(deliveredTo === null ? [] : [`<consegna>${deliveredTo}</consegna>`]),
    ...(errorDetail === null
      ? []
      : [`<errore-esteso>${errorDetail}</errore-esteso>`]),
    "</dati>",
    "</postacert>",
  ]
    .filter(Boolean)
    .join("\n");

/** The sender's own message, as the transport envelope carries it. */
export const pecOriginalMessage = () =>
  [
    `From: "Studio di prova" <${PEC_FIXTURE.sender}>`,
    `To: ${PEC_FIXTURE.certifiedRecipient}`,
    `Cc: ${PEC_FIXTURE.externalRecipient}`,
    `Subject: ${PEC_FIXTURE.subject}`,
    "Date: Sat, 21 Nov 2026 10:15:00 +0100",
    `Message-ID: ${PEC_FIXTURE.originalMessageId}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="original-boundary"',
    "",
    "--original-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    PEC_FIXTURE.body,
    "--original-boundary",
    `Content-Type: text/plain; name="${PEC_FIXTURE.attachmentName}"`,
    `Content-Disposition: attachment; filename="${PEC_FIXTURE.attachmentName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(PEC_FIXTURE.attachmentText),
    "--original-boundary--",
    "",
  ].join(CRLF);

type PecMessageOptions = {
  /** The provider header: `X-Trasporto` or `X-Ricevuta`, with its value. */
  providerHeader?: readonly [string, string] | null;
  subjectPrefix?: string;
  notice?: string;
  daticert?: string | null;
  /** The certification data part's name; detection never reads it. */
  daticertName?: string;
  original?: string | null;
  originalDisposition?: "inline" | "attachment";
  signed?: boolean;
  extraParts?: readonly { name: string; mimeType: string; content: string }[];
};

/** A provider message as the recipient's mailbox stores it. */
export const pecMessage = async ({
  providerHeader = ["X-Trasporto", "posta-certificata"],
  subjectPrefix = "POSTA CERTIFICATA: ",
  notice = `Messaggio di posta certificata\nIl giorno 21/11/2026 alle ore 10:15:30 (+0100) il messaggio\n"${PEC_FIXTURE.subject}" è stato inviato da "${PEC_FIXTURE.sender}"\nIl messaggio originale è incluso in allegato.\nIdentificativo messaggio: ${PEC_FIXTURE.messageId}`,
  daticert = pecDaticert(),
  daticertName = "daticert.xml",
  original = pecOriginalMessage(),
  originalDisposition = "inline",
  signed = true,
  extraParts = [],
}: PecMessageOptions = {}): Promise<Uint8Array> => {
  const signedPart = [
    'Content-Type: multipart/mixed; boundary="mixed-boundary"',
    "",
    "--mixed-boundary",
    'Content-Type: multipart/alternative; boundary="alternative-boundary"',
    "",
    "--alternative-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(notice),
    "--alternative-boundary",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(`<p>${notice.replaceAll("\n", "<br>")}</p>`),
    "--alternative-boundary--",
    ...(daticert === null
      ? []
      : [
          "--mixed-boundary",
          `Content-Type: application/xml; name="${daticertName}"`,
          `Content-Disposition: inline; filename="${daticertName}"`,
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(daticert),
        ]),
    ...(original === null
      ? []
      : [
          "--mixed-boundary",
          'Content-Type: message/rfc822; name="postacert.eml"',
          `Content-Disposition: ${originalDisposition}; filename="postacert.eml"`,
          "",
          original,
        ]),
    ...extraParts.flatMap(({ name, mimeType, content }) => [
      "--mixed-boundary",
      `Content-Type: ${mimeType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(content),
    ]),
    "--mixed-boundary--",
    "",
  ].join(CRLF);
  const signature = signed
    ? await wrapP7m(new TextEncoder().encode(signedPart), { detached: true })
    : null;
  const message = [
    ...(providerHeader === null
      ? []
      : [`${providerHeader[0]}: ${providerHeader[1]}`]),
    `From: "Per conto di: ${PEC_FIXTURE.sender}" <posta-certificata@pec.example.com>`,
    `Reply-To: ${PEC_FIXTURE.sender}`,
    `To: ${PEC_FIXTURE.certifiedRecipient}`,
    `Subject: =?UTF-8?B?${Buffer.from(`${subjectPrefix}${PEC_FIXTURE.subject}`).toString("base64")}?=`,
    "Date: Sat, 21 Nov 2026 10:15:30 +0100",
    `Message-ID: <${PEC_FIXTURE.messageId}>`,
    "MIME-Version: 1.0",
    ...(signature === null
      ? [signedPart]
      : [
          'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="signed-boundary"',
          "",
          "--signed-boundary",
          signedPart,
          "--signed-boundary",
          'Content-Type: application/pkcs7-signature; name="smime.p7s"',
          'Content-Disposition: attachment; filename="smime.p7s"',
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(signature),
          "--signed-boundary--",
          "",
        ]),
  ].join(CRLF);
  return new TextEncoder().encode(message);
};

/** A delivery receipt (ricevuta di avvenuta consegna) of the requested type. */
export const pecDeliveryReceipt = async (
  receipt: "completa" | "breve" | "sintetica",
) =>
  await pecMessage({
    providerHeader: ["X-Ricevuta", "avvenuta-consegna"],
    subjectPrefix: "CONSEGNA: ",
    notice: `Ricevuta di avvenuta consegna\nIl messaggio "${PEC_FIXTURE.subject}" è stato consegnato nella casella di destinazione.`,
    daticert: pecDaticert({
      type: "avvenuta-consegna",
      receipt,
      deliveredTo: PEC_FIXTURE.certifiedRecipient,
    }),
    original: receipt === "sintetica" ? null : pecOriginalMessage(),
  });
