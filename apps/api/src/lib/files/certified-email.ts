/**
 * Reads Italian PEC (posta elettronica certificata) messages: the transport
 * envelope that carries an original message, and the receipts and notices
 * the providers send about it. Every such message is an S/MIME
 * `multipart/signed` email whose top level holds the provider's text, the
 * certification data as XML (root `postacert`), and, for a transport envelope
 * or a full delivery receipt, the original message as `message/rfc822`.
 *
 * The parts are found by their content, never by their names. The provider's
 * signature is read as stated and never verified.
 *
 * Spec: AgID technical rules of DM 2 November 2005 (annex), sections 6.1
 * (message format), 6.3.4 (transport envelope), 6.3.3, 6.4.1, 6.5.2, 6.5.3
 * (receipts and notices), 7.3 (parts) and 7.4 (certification data DTD).
 *
 * Pure and synchronous: the sandboxed extraction worker imports it too.
 */
import { Result } from "better-result";
import { type Element, parseXmlDocument } from "slimdom";
import * as v from "valibot";

import { apiDateTimeSchema, isApiDate } from "@stll/api-contract/api-date";
import type {
  CertifiedEmailEnvelope,
  CertifiedEmailError,
  CertifiedEmailKind,
  CertifiedEmailReceiptType,
  CertifiedEmailSignature,
} from "@stll/api-contract/certified-email";

import {
  hasCmsSignedDataHeader,
  readDetachedCmsSigners,
} from "@/api/lib/files/cms-signed-data";

export const CERTIFIED_EMAIL_LIMITS = {
  /** A real certification data part is a few kilobytes. */
  maxDataBytes: 256 * 1024,
  /** Markup count, a cheap bound on the element tree a parse may build. */
  maxMarkup: 20_000,
  maxRecipients: 1000,
  maxFieldCharacters: 4096,
} as const;

/** `postacert` `tipo` values (DTD, section 7.4). */
const KIND_BY_TYPE: ReadonlyMap<string, CertifiedEmailKind> = new Map([
  ["posta-certificata", "transport"],
  ["accettazione", "acceptance"],
  ["non-accettazione", "non_acceptance"],
  ["presa-in-carico", "taken_in_charge"],
  ["avvenuta-consegna", "delivery"],
  ["errore-consegna", "delivery_error"],
  ["preavviso-errore-consegna", "delivery_error_warning"],
  ["rilevazione-virus", "virus_detected"],
]);

/** `postacert` `errore` values; the DTD's default is `nessuno`. */
const ERROR_BY_VALUE: ReadonlyMap<string, CertifiedEmailError> = new Map([
  ["nessuno", "none"],
  ["no-dest", "no_recipient"],
  ["no-dominio", "no_domain"],
  ["virus", "virus"],
  ["altro", "other"],
]);

const RECEIPT_TYPE_BY_VALUE: ReadonlyMap<string, CertifiedEmailReceiptType> =
  new Map([
    ["completa", "full"],
    ["breve", "short"],
    ["sintetica", "summary"],
  ]);

/** Every provider message carries one of these headers (section 6.1). */
const PROVIDER_HEADERS = new Set(["x-ricevuta", "x-trasporto"]);

const ROOT_ELEMENT = "postacert";
const ROOT_PREFIX = /<postacert[\s>/]/u;
const HEAD_BYTES = 2048;
// A document type declaration may name the DTD; one with an internal subset
// or entity definitions brings nothing this reader has a use for.
const EXTERNAL_DOCUMENT_TYPE =
  /<!DOCTYPE\s+postacert(?:\s+(?:SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*')|PUBLIC\s+(?:"[^"<>]*"|'[^'<>]*')\s+(?:"[^"<>]*"|'[^'<>]*')))?\s*>/u;
const ANY_DOCUMENT_TYPE = /<!doctype|<!entity/iu;
const LATIN_ONE_DECLARATION =
  /^<\?xml[^>]*encoding\s*=\s*["'](?:iso-8859-1|latin-?1|windows-1252)["']/iu;

type CertifiedEmailLimits = Record<keyof typeof CERTIFIED_EMAIL_LIMITS, number>;

/** One top-level part of the provider's message, decoded. */
type CertifiedEmailPart = {
  readonly mimeType: string | null;
  readonly bytes: Uint8Array;
};

export type CertifiedEmailParts = {
  readonly envelope: CertifiedEmailEnvelope;
  /** The original message's RFC 822 bytes, when the message carries it. */
  readonly original: Uint8Array | null;
  /** The positions of the parts the envelope stands for. */
  readonly certificationParts: ReadonlySet<number>;
};

/** A cheap test of a part's head, before any part is parsed as XML. */
export const mayBeCertificationData = (bytes: Uint8Array): boolean =>
  bytes.byteLength <= CERTIFIED_EMAIL_LIMITS.maxDataBytes &&
  ROOT_PREFIX.test(
    new TextDecoder("latin1").decode(bytes.subarray(0, HEAD_BYTES)),
  );

const isControlCharacter = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
};

// A field is one line of text: control characters read as spaces.
const boundedText = (
  value: string | null | undefined,
  limits: CertifiedEmailLimits,
) => {
  const head = (value ?? "").slice(0, 2 * limits.maxFieldCharacters);
  const text = Array.from(head, (character) =>
    isControlCharacter(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text.slice(0, limits.maxFieldCharacters) : null;
};

const children = (element: Element, localName: string) =>
  element.children.filter(
    (candidate) =>
      candidate.namespaceURI === null && candidate.localName === localName,
  );

const onlyChild = (element: Element, localName: string) => {
  const found = children(element, localName);
  return found.length === 1 ? found[0] : undefined;
};

const fieldText = (
  element: Element,
  localName: string,
  limits: CertifiedEmailLimits,
) => {
  const field = onlyChild(element, localName);
  return field === undefined ? null : boundedText(field.textContent, limits);
};

const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/u;
const TIME = /^(\d{2}):(\d{2}):(\d{2})$/u;
const ZONE = /^([+-])(\d{2})(\d{2})$/u;

/**
 * `data`: a local day (`gg/mm/aaaa`) and time (`hh:mm:ss`) with the zone
 * (`[+|-]hhmm`) they are in (sections 7.2 and 7.4), as an instant.
 */
const readCertifiedAt = (dati: Element, limits: CertifiedEmailLimits) => {
  const data = onlyChild(dati, "data");
  if (data === undefined) {
    return null;
  }
  const day = DAY.exec(fieldText(data, "giorno", limits) ?? "");
  const time = TIME.exec(fieldText(data, "ora", limits) ?? "");
  const zone = ZONE.exec(data.getAttribute("zona")?.trim() ?? "");
  if (!day || !time || !zone) {
    return null;
  }
  const [, dd, mm, yyyy] = day;
  const [, sign, zoneHours, zoneMinutes] = zone;
  const date = `${yyyy}-${mm}-${dd}`;
  const stated = `${date}T${time[0]}${sign}${zoneHours}:${zoneMinutes}`;
  // Date alone would roll an impossible calendar day into the next month.
  if (!isApiDate(date) || !v.is(apiDateTimeSchema, stated)) {
    return null;
  }
  const instant = new Date(stated);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
};

const decodeXml = (bytes: Uint8Array) => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
  // The rules require UTF-8 (section 7.3.3); a part that declares Latin-1
  // is read as it declares.
  if (LATIN_ONE_DECLARATION.test(head)) {
    return Result.ok(new TextDecoder("windows-1252").decode(bytes));
  }
  return Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
};

const parseRoot = (bytes: Uint8Array, limits: CertifiedEmailLimits) => {
  if (bytes.byteLength > limits.maxDataBytes) {
    return null;
  }
  const decoded = decodeXml(bytes);
  if (decoded.isErr()) {
    return null;
  }
  const xml = decoded.value.replace(EXTERNAL_DOCUMENT_TYPE, "");
  if (ANY_DOCUMENT_TYPE.test(xml)) {
    return null;
  }
  let markup = 0;
  for (let index = xml.indexOf("<"); index !== -1;) {
    markup += 1;
    if (markup > limits.maxMarkup) {
      return null;
    }
    index = xml.indexOf("<", index + 1);
  }
  const document = Result.try(() => parseXmlDocument(xml));
  const root = document.isOk() ? document.value.documentElement : null;
  return root?.namespaceURI === null && root.localName === ROOT_ELEMENT
    ? root
    : null;
};

type CertificationData = Omit<
  CertifiedEmailEnvelope,
  "includesOriginal" | "signature"
>;

/** The certification data of one part, or null when it states none. */
export const readCertificationData = (
  bytes: Uint8Array,
  limits: CertifiedEmailLimits = CERTIFIED_EMAIL_LIMITS,
): CertificationData | null => {
  const root = parseRoot(bytes, limits);
  if (root === null) {
    return null;
  }
  const kind = KIND_BY_TYPE.get(root.getAttribute("tipo")?.trim() ?? "");
  const error = ERROR_BY_VALUE.get(
    root.getAttribute("errore")?.trim() ?? "nessuno",
  );
  const intestazione = onlyChild(root, "intestazione");
  const dati = onlyChild(root, "dati");
  if (
    kind === undefined ||
    error === undefined ||
    intestazione === undefined ||
    dati === undefined
  ) {
    return null;
  }
  const recipientElements = children(intestazione, "destinatari");
  if (recipientElements.length > limits.maxRecipients) {
    return null;
  }
  const recipients = recipientElements.flatMap((element) => {
    const address = boundedText(element.textContent, limits);
    return address === null
      ? []
      : [{ address, certified: element.getAttribute("tipo") !== "esterno" }];
  });
  const receivedFor = children(dati, "ricezione").flatMap((element) => {
    const address = boundedText(element.textContent, limits);
    return address === null ? [] : [address];
  });
  if (receivedFor.length > limits.maxRecipients) {
    return null;
  }
  const receipt = onlyChild(dati, "ricevuta");
  return {
    system: "pec",
    kind,
    error,
    errorDetail: fieldText(dati, "errore-esteso", limits),
    sender: fieldText(intestazione, "mittente", limits),
    recipients,
    replyTo: fieldText(intestazione, "risposte", limits),
    subject: fieldText(intestazione, "oggetto", limits),
    provider: fieldText(dati, "gestore-emittente", limits),
    certifiedAt: readCertifiedAt(dati, limits),
    messageId: fieldText(dati, "identificativo", limits),
    originalMessageId: fieldText(dati, "msgid", limits),
    receiptType:
      RECEIPT_TYPE_BY_VALUE.get(receipt?.getAttribute("tipo")?.trim() ?? "") ??
      null,
    deliveredTo: fieldText(dati, "consegna", limits),
    receivedFor,
  };
};

const readSignature = (bytes: Uint8Array): CertifiedEmailSignature | null => {
  if (!hasCmsSignedDataHeader(bytes)) {
    return null;
  }
  const signers = readDetachedCmsSigners(bytes);
  if (signers.isErr()) {
    return null;
  }
  const signer = signers.value.at(0);
  return {
    status: "unverified",
    signerName: signer?.name ?? null,
    issuerName: signer?.issuerName ?? null,
    serialNumber: signer?.serialNumber ?? null,
    signedAt: signer?.signedAt ?? null,
  };
};

const isMessagePart = ({ mimeType }: CertifiedEmailPart) =>
  mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "message/rfc822";

/**
 * The certified reading of a message from its header names and top-level
 * parts, or null when it is not a provider's message: it must carry a
 * provider header, exactly one part of certification data and exactly one
 * signature part. The signature is read, never verified, so the reading is
 * what the file states.
 */
export const readCertifiedEmailParts = (
  {
    headerNames,
    parts,
  }: {
    headerNames: readonly string[];
    parts: readonly CertifiedEmailPart[];
  },
  limits: CertifiedEmailLimits = CERTIFIED_EMAIL_LIMITS,
): CertifiedEmailParts | null => {
  if (!headerNames.some((name) => PROVIDER_HEADERS.has(name.toLowerCase()))) {
    return null;
  }
  const data = parts.flatMap((part, index) => {
    const read = mayBeCertificationData(part.bytes)
      ? readCertificationData(part.bytes, limits)
      : null;
    return read === null ? [] : [{ read, index }];
  });
  const [certification] = data;
  if (certification === undefined || data.length !== 1) {
    return null;
  }
  const certificationParts = new Set([certification.index]);
  const signatures = parts.flatMap((part, index) => {
    const signature = readSignature(part.bytes);
    return signature === null ? [] : [{ signature, index }];
  });
  // Every provider message is signed (6.1); unsigned data states nothing.
  const [signature] = signatures;
  if (signature === undefined || signatures.length !== 1) {
    return null;
  }
  certificationParts.add(signature.index);
  // The rules attach one original message; with more, none is the original.
  const messages = parts.flatMap((part, index) =>
    isMessagePart(part) ? [{ bytes: part.bytes, index }] : [],
  );
  const [message] = messages;
  const original =
    message !== undefined && messages.length === 1 ? message : null;
  if (original !== null) {
    certificationParts.add(original.index);
  }
  return {
    envelope: {
      ...certification.read,
      includesOriginal: original !== null,
      signature: signature.signature,
    },
    original: original?.bytes ?? null,
    certificationParts,
  };
};

const line = (label: string, value: string | null) =>
  value === null || value === "" ? [] : [`${label}: ${value}`];

const KIND_TEXT = {
  transport: "transport envelope (busta di trasporto)",
  acceptance: "acceptance receipt (ricevuta di accettazione)",
  non_acceptance: "non-acceptance notice (avviso di non accettazione)",
  taken_in_charge: "taken-in-charge receipt (ricevuta di presa in carico)",
  delivery: "delivery receipt (ricevuta di avvenuta consegna)",
  delivery_error: "non-delivery notice (avviso di mancata consegna)",
  delivery_error_warning:
    "delivery timeout notice (avviso di mancata consegna per superamento dei tempi massimi)",
  virus_detected: "virus detection notice (avviso di rilevazione virus)",
} as const satisfies Record<CertifiedEmailKind, string>;

const ERROR_TEXT = {
  none: null,
  no_recipient: "unknown recipient",
  no_domain: "unknown domain",
  virus: "virus",
  other: "other error",
} as const satisfies Record<CertifiedEmailError, string | null>;

/** Stable, labeled certification text shared by search, file reads and AI context. */
export const certifiedEmailText = (envelope: CertifiedEmailEnvelope) => {
  const { signature } = envelope;
  return [
    `Italian certified email (PEC) as stated in the file, not verified: ${KIND_TEXT[envelope.kind]}`,
    ...line("Stated sender", envelope.sender),
    ...envelope.recipients.map(
      ({ address, certified }) =>
        `Stated recipient: ${address} (${certified ? "certified mailbox" : "ordinary mailbox"})`,
    ),
    ...line("Stated subject", envelope.subject),
    ...line("Delivered to", envelope.deliveredTo),
    ...envelope.receivedFor.map((address) => `Taken in charge for: ${address}`),
    ...line("Certified at", envelope.certifiedAt),
    ...line("Provider", envelope.provider),
    ...line("PEC message ID", envelope.messageId),
    ...line("Original Message-ID", envelope.originalMessageId),
    ...line("Requested receipt", envelope.receiptType),
    ...line("Error", ERROR_TEXT[envelope.error]),
    ...line("Error detail", envelope.errorDetail),
    "Provider signature: unverified",
    ...line("Stated signer", signature.signerName),
    ...line("Stated issuer", signature.issuerName),
    ...line("Stated signing time", signature.signedAt),
  ].join("\n");
};
