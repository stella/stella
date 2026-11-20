import type { DataBoxParty } from "@stll/api-contract/data-box";

import type {
  DataBoxMessageMetadata,
  DataBoxReceipt,
} from "./preview-contract";

type ReadableDataBoxDocument =
  | (Omit<DataBoxMessageMetadata, "files"> & {
      files: readonly { fileName: string }[];
    })
  | DataBoxReceipt;

const line = (label: string, value: string | boolean | null) =>
  value === null || value === "" ? [] : [`${label}: ${value}`];

const partyLines = (label: string, party: DataBoxParty) => [
  ...line(label, party.name),
  ...line(`${label} box ID`, party.boxId),
  ...line(`${label} address`, party.address),
  ...line(`${label} reference (číslo jednací)`, party.referenceNumber),
  ...line(`${label} file mark (spisová značka)`, party.fileMark),
];

/** Stable, labeled source text shared by search, file reads and AI context. */
export const dataBoxDocumentText = (
  document: ReadableDataBoxDocument,
): string => {
  const { annotation, envelope } = document;
  const { seal } = envelope;
  return [
    document.kind === "message"
      ? "ISDS data-box message (datová zpráva)"
      : "ISDS delivery receipt (doručenka)",
    ...line("Message ID", envelope.messageId),
    ...line("Subject", annotation),
    ...partyLines("Sender", envelope.sender),
    ...partyLines("Recipient", envelope.recipient),
    ...line("To the attention of", envelope.toHands),
    ...line("Delivered to data box (dodáno)", envelope.deliveredAt),
    ...line("Accepted (doručeno)", envelope.acceptedAt),
    ...line("Message status", envelope.status?.replaceAll("_", " ") ?? null),
    ...line("Message type", envelope.messageType),
    ...line("Personal delivery", envelope.personalDelivery),
    ...line("Substitute delivery allowed", envelope.substituteDelivery),
    ...line("File seal", seal.status),
    ...line("Stated signer", seal.signerName),
    ...line("Stated issuer", seal.issuerName),
    ...line("Stated serial number", seal.serialNumber),
    ...line("Stated signing time", seal.signedAt),
    ...(document.kind === "message"
      ? document.files.map(({ fileName }) => `Attachment: ${fileName}`)
      : document.events.map(
          ({ occurredAt, description }) =>
            `Delivery event: ${[occurredAt, description].filter(Boolean).join(" — ")}`,
        )),
  ].join("\n");
};
