/**
 * Czech data-box (ISDS) messages: electronic registered mail between data
 * boxes. A message is exported as a `.zfo` file, a CMS SignedData whose
 * content is the ISDS message XML (envelope and base64 files).
 */

import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import { legalFileFormat } from "./document-format";
import { DATA_BOX_FILE_FORMAT } from "./legal-file-formats";

export const DATA_BOX_MESSAGE_MIME_TYPE = DATA_BOX_FILE_FORMAT.mimeType;

export const DATA_BOX_DOCUMENT_KIND = {
  message: "message",
  receipt: "receipt",
} as const;

export const DATA_BOX_DOCUMENT_KINDS = Object.values(DATA_BOX_DOCUMENT_KIND);

export const DATA_BOX_ID_LENGTH = 7;

/**
 * A stored box ID: seven characters, lowercase like contact data boxes. Input
 * readers accept either case (`@stll/agent-input`) and store it lowercased.
 */
export const STORED_DATA_BOX_ID_PATTERN = /^[a-z0-9]{7}$/u;

/** At most this many of the organization's own boxes are recorded. */
export const ORGANIZATION_DATA_BOX_LIMIT = 20;

/** Why a change to the organization's own boxes was refused. */
export const ORGANIZATION_DATA_BOX_REFUSAL_CODE = {
  limitReached: "organization_data_box_limit_reached",
  changedConcurrently: "organization_data_boxes_changed",
} as const;

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

const nullableText = v.nullable(v.string());
const nullableTimestamp = v.nullable(apiDateTimeSchema);

const dataBoxPartySchema = v.object({
  boxId: v.pipe(v.string(), v.regex(STORED_DATA_BOX_ID_PATTERN)),
  name: nullableText,
  address: nullableText,
  /** The party's reference number (číslo jednací). */
  referenceNumber: nullableText,
  /** The party's file mark (spisová značka). */
  fileMark: nullableText,
});
export type DataBoxParty = v.InferOutput<typeof dataBoxPartySchema>;

/** The system's electronic seal over the file, as stated in its signed container. */
const dataBoxSealSchema = v.object({
  status: v.literal("unverified"),
  signerName: nullableText,
  issuerName: nullableText,
  serialNumber: nullableText,
  signedAt: nullableTimestamp,
});
export type DataBoxSeal = v.InferOutput<typeof dataBoxSealSchema>;

export const dataBoxDeliveryEventSchema = v.object({
  occurredAt: nullableTimestamp,
  description: nullableText,
});
export type DataBoxDeliveryEvent = v.InferOutput<
  typeof dataBoxDeliveryEventSchema
>;

/** The envelope exactly as the exported file states it. */
export const dataBoxStatedEnvelopeSchema = v.object({
  messageId: v.pipe(v.string(), v.regex(DATA_BOX_MESSAGE_ID_PATTERN)),
  /** `dmType`: a one-letter message kind (V public, K postal, ...). */
  messageType: nullableText,
  sender: dataBoxPartySchema,
  recipient: dataBoxPartySchema,
  toHands: nullableText,
  personalDelivery: v.nullable(v.boolean()),
  substituteDelivery: v.nullable(v.boolean()),
  /** Dodání: when the message reached the recipient's box. */
  deliveredAt: nullableTimestamp,
  /** Doručení: when the message was accepted, by login or by fiction. */
  acceptedAt: nullableTimestamp,
  status: v.nullable(v.picklist(DATA_BOX_MESSAGE_STATUSES)),
  seal: dataBoxSealSchema,
});
export type DataBoxStatedEnvelope = v.InferOutput<
  typeof dataBoxStatedEnvelopeSchema
>;

/** The organization's current box inventory supplies the message direction. */
export type DataBoxEnvelope = DataBoxStatedEnvelope & {
  directionBasis: DataBoxDirectionBasis;
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
  const format = legalFileFormat(mimeType, fileName);
  return format?.kind === DATA_BOX_FILE_FORMAT.kind ? format.mimeType : null;
};
