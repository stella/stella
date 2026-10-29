/**
 * Czech data-box (ISDS) messages: electronic registered mail between data
 * boxes. A message is exported as a `.zfo` file, a CMS SignedData whose
 * content is the ISDS message XML (envelope and base64 files).
 */

/** The registered media type for the `.zfo` extension. */
export const DATA_BOX_MESSAGE_MIME_TYPE =
  "application/vnd.software602.filler.form-xml-zip";

const DATA_BOX_MESSAGE_EXTENSION = "zfo";

export const DATA_BOX_ID_LENGTH = 7;

/** A box ID: seven characters, stored lowercase like contact data boxes. */
export const DATA_BOX_ID_PATTERN = /^[a-z0-9]{7}$/u;

/** At most this many of the organization's own boxes are recorded. */
export const ORGANIZATION_DATA_BOX_LIMIT = 20;

/**
 * How a message's direction was derived from the organization's own boxes:
 * sent from one is outgoing, sent to one is incoming. A message neither (or
 * both) of whose boxes is the organization's is filed incoming with an
 * unknown basis.
 */
export const DATA_BOX_DIRECTION_BASES = [
  "organization_sender",
  "organization_recipient",
  "unknown",
] as const;
export type DataBoxDirectionBasis = (typeof DATA_BOX_DIRECTION_BASES)[number];

/** A message ID (dmID): the system's decimal identifier. */
export const DATA_BOX_MESSAGE_ID_PATTERN = /^[0-9]{1,20}$/u;

/**
 * `dmMessageStatus` codes 1 to 10, in order. `accepted_by_fiction` is the
 * state after the statutory period passed without a login; a later status
 * (read, deleted, archived) no longer says how the message was accepted.
 */
export const DATA_BOX_MESSAGE_STATUSES = [
  "submitted",
  "timestamped",
  "infected",
  "delivered",
  "accepted_by_fiction",
  "accepted_by_login",
  "read",
  "undeliverable",
  "content_deleted",
  "in_vault",
] as const;
export type DataBoxMessageStatus = (typeof DATA_BOX_MESSAGE_STATUSES)[number];

export type DataBoxParty = {
  boxId: string;
  name: string | null;
  address: string | null;
  /** The party's reference number (číslo jednací). */
  referenceNumber: string | null;
  /** The party's file mark (spisová značka). */
  fileMark: string | null;
};

/**
 * The system's electronic seal over the exported file, as found in it. It is
 * kept with the source file and never verified, here or over the network.
 */
export type DataBoxSeal = {
  status: "unverified";
  signerName: string | null;
  issuerName: string | null;
  serialNumber: string | null;
  signedAt: string | null;
};

/**
 * The message envelope as stated in the exported file, with its direction
 * basis derived from the organization's current data boxes on this read.
 */
export type DataBoxEnvelope = DataBoxStatedEnvelope & {
  directionBasis: DataBoxDirectionBasis;
};

/** The envelope exactly as the exported file states it. */
export type DataBoxStatedEnvelope = {
  messageId: string;
  /** `dmType`: a one-letter message kind (V public, K postal, ...). */
  messageType: string | null;
  sender: DataBoxParty;
  recipient: DataBoxParty;
  toHands: string | null;
  personalDelivery: boolean | null;
  substituteDelivery: boolean | null;
  /** Dodání: when the message reached the recipient's box. */
  deliveredAt: string | null;
  /** Doručení: when the message was accepted, by login or by fiction. */
  acceptedAt: string | null;
  status: DataBoxMessageStatus | null;
  seal: DataBoxSeal;
};

/** The organization's own data boxes, lowercase. */
export type OrganizationDataBoxesResponse = {
  boxIds: string[];
};

export type UpdateOrganizationDataBoxesResponse = OrganizationDataBoxesResponse;

export const isDataBoxMessageMimeType = (
  mimeType: string | null | undefined,
): boolean => mimeType === DATA_BOX_MESSAGE_MIME_TYPE;

type ResolveDataBoxMessageMimeTypeOptions = {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
};

/** The data-box media type a file carries, falling back to its extension. */
export const resolveDataBoxMessageMimeType = ({
  fileName,
  mimeType,
}: ResolveDataBoxMessageMimeTypeOptions): string | null => {
  if (isDataBoxMessageMimeType(mimeType)) {
    return DATA_BOX_MESSAGE_MIME_TYPE;
  }
  const dotIndex = fileName?.lastIndexOf(".") ?? -1;
  if (!fileName || dotIndex === -1) {
    return null;
  }
  return fileName.slice(dotIndex + 1).toLowerCase() ===
    DATA_BOX_MESSAGE_EXTENSION
    ? DATA_BOX_MESSAGE_MIME_TYPE
    : null;
};
