/**
 * The reviewed-contact shape shared by every contact import surface, derived
 * from the `/contacts/import/validate` response rather than restated here: a
 * change to the candidate the server builds moves the studio, the procuração
 * flow, and the retry-identity helper together instead of leaving one holding
 * a stale copy.
 */

import type { ContactImportField, ContactType } from "@stll/api-contract";

import type { api } from "@/lib/api";

type ValidateResponse = Awaited<
  ReturnType<typeof api.contacts.import.validate.post>
>;

type ValidateData = Exclude<
  NonNullable<Extract<ValidateResponse, { data: unknown }>["data"]>,
  Response
>;

/** One reviewed contact as the server hands it back; the editable shape. */
export type ImportCandidate = ValidateData["rows"][number]["contact"];
export type ImportIssue = ValidateData["rows"][number]["issues"][number];

/**
 * The same contact as a request body accepts it. It differs from
 * {@link ImportCandidate} only in that an absent field must be absent rather
 * than present-and-undefined, which is what `toWireCandidate` settles.
 */
export type WireImportCandidate = Parameters<
  typeof api.contacts.import.validate.post
>[0]["rows"][number];

/** The body `PUT /contacts/import` takes, minus the retry identity. */
export type ImportCommitPayload = Omit<
  Parameters<typeof api.contacts.import.put>[0],
  "importRequestId"
>;

type CommitResponse = Awaited<ReturnType<typeof api.contacts.import.put>>;

type CommitData = Exclude<
  NonNullable<Extract<CommitResponse, { data: unknown }>["data"]>,
  Response
>;

export type ImportSkipReason = Extract<
  CommitData["results"][number],
  { status: "skipped" }
>["reason"];

type ImportCustomField = NonNullable<
  NonNullable<ImportCandidate["metadata"]>["customFields"]
>[number];

type ImportAddress = NonNullable<ImportCandidate["addresses"]>[number];

// Shared empty stand-ins: a candidate without addresses or custom fields reads
// as the same value on every render, so nothing downstream sees a new array.
const NO_ADDRESSES: ImportAddress[] = [];
const NO_CUSTOM_FIELDS: ImportCustomField[] = [];

/**
 * The fields a reviewer may edit on a card. They are named with the import
 * contract's field names, so a mapping target, an issue's `field`, and an
 * input all denote the same thing without a translation table.
 */
export const IMPORT_EDITABLE_FIELDS = [
  "type",
  "display_name",
  "first_name",
  "last_name",
  "organization_name",
  "primary_email",
  "primary_phone",
  "address_line_1",
  "tax_id",
  "registration_number",
  "notes",
] as const satisfies readonly ContactImportField[];

export type ImportEditableField = (typeof IMPORT_EDITABLE_FIELDS)[number];

/** Everything except `type`, which is a choice rather than free text. */
export type ImportEditableTextField = Exclude<ImportEditableField, "type">;

const CANDIDATE_TEXT_VALUE = {
  display_name: ({ displayName }) => displayName,
  first_name: ({ firstName }) => firstName,
  last_name: ({ lastName }) => lastName,
  organization_name: ({ organizationName }) => organizationName,
  primary_email: ({ emails }) => emails?.at(0)?.address,
  primary_phone: ({ phones }) => phones?.at(0)?.number,
  address_line_1: ({ addresses }) => addresses?.at(0)?.line1,
  tax_id: ({ taxId }) => taxId,
  registration_number: ({ registrationNumber }) => registrationNumber,
  notes: ({ notes }) => notes,
} as const satisfies Record<
  ImportEditableTextField,
  (candidate: ImportCandidate) => string | undefined
>;

export const readCandidateField = (
  candidate: ImportCandidate,
  field: ImportEditableTextField,
): string => CANDIDATE_TEXT_VALUE[field](candidate) ?? "";

const withAddressLine1 = (
  candidate: ImportCandidate,
  value: string,
): ImportCandidate => {
  const [first, ...rest] = candidate.addresses ?? NO_ADDRESSES;
  if (!first) {
    return value
      ? {
          ...candidate,
          addresses: [{ type: "office", line1: value, isPrimary: true }],
        }
      : candidate;
  }
  const carriesOtherParts = [
    first.line2,
    first.city,
    first.state,
    first.postalCode,
    first.country,
  ].some(Boolean);
  if (!value && !carriesOtherParts) {
    return { ...candidate, addresses: rest.length > 0 ? rest : undefined };
  }
  return { ...candidate, addresses: [{ ...first, line1: value }, ...rest] };
};

const CANDIDATE_TEXT_WRITER = {
  display_name: (candidate, value) => ({ ...candidate, displayName: value }),
  first_name: (candidate, value) => ({
    ...candidate,
    firstName: value || undefined,
  }),
  last_name: (candidate, value) => ({
    ...candidate,
    lastName: value || undefined,
  }),
  organization_name: (candidate, value) => ({
    ...candidate,
    organizationName: value || undefined,
  }),
  primary_email: (candidate, value) => ({
    ...candidate,
    emails: value
      ? [{ type: "work", address: value, isPrimary: true }]
      : undefined,
  }),
  primary_phone: (candidate, value) => ({
    ...candidate,
    phones: value
      ? [{ type: "mobile", number: value, isPrimary: true }]
      : undefined,
  }),
  address_line_1: withAddressLine1,
  tax_id: (candidate, value) => ({ ...candidate, taxId: value || undefined }),
  registration_number: (candidate, value) => ({
    ...candidate,
    registrationNumber: value || undefined,
  }),
  notes: (candidate, value) => ({ ...candidate, notes: value || undefined }),
} as const satisfies Record<
  ImportEditableTextField,
  (candidate: ImportCandidate, value: string) => ImportCandidate
>;

export const writeCandidateField = (
  candidate: ImportCandidate,
  field: ImportEditableTextField,
  value: string,
): ImportCandidate => CANDIDATE_TEXT_WRITER[field](candidate, value);

export const withCandidateType = (
  candidate: ImportCandidate,
  type: ContactType,
): ImportCandidate => ({ ...candidate, type });

const CUSTOM_FIELD_ID_MAX_LENGTH = 64;
const CUSTOM_FIELD_ID_SUFFIX_BUDGET = 8;

const normalizeCustomFieldToken = (label: string): string =>
  label
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, CUSTOM_FIELD_ID_MAX_LENGTH - CUSTOM_FIELD_ID_SUFFIX_BUDGET);

/**
 * A custom field's id is derived from its label and its position, never
 * randomly: the same reviewed contact re-sent after a retry carries the same
 * ids, and two fields whose labels normalize alike stay distinct.
 */
export const customFieldId = (label: string, index: number): string =>
  `${normalizeCustomFieldToken(label) || "field"}-${index}`;

export const readCustomFields = (
  candidate: ImportCandidate,
): ImportCustomField[] => candidate.metadata?.customFields ?? NO_CUSTOM_FIELDS;

export const withCustomFields = (
  candidate: ImportCandidate,
  customFields: ImportCustomField[],
): ImportCandidate => {
  const { dataBoxes } = candidate.metadata ?? {};
  if (customFields.length === 0 && !dataBoxes) {
    return { ...candidate, metadata: undefined };
  }
  return {
    ...candidate,
    metadata: {
      ...(dataBoxes && { dataBoxes }),
      customFields,
    },
  };
};

/** Every field `toWireCandidate` copies onto the request body. */
type SentCandidateField =
  | "addresses"
  | "displayName"
  | "emails"
  | "firstName"
  | "lastName"
  | "metadata"
  | "middleName"
  | "notes"
  | "organizationName"
  | "phones"
  | "prefix"
  | "registrationNumber"
  | "suffix"
  | "tags"
  | "taxId"
  | "type";

/**
 * `Record<never, never>` is the empty object, so while every request field is
 * sent this is exactly `WireImportCandidate`. Add a field to the candidate
 * schema and the intersection starts demanding `never` for it, which no value
 * satisfies: a field the API grows cannot be silently dropped on the way out.
 */
type WireCandidateResult = WireImportCandidate &
  Record<Exclude<keyof WireImportCandidate, SentCandidateField>, never>;

/**
 * The candidate as it goes over the wire. Only structural tidying happens
 * here: an absent field is left out rather than sent as `undefined`, and a
 * half-typed custom field carries no label the request schema would accept.
 * Every content rule stays on the server.
 */
export const toWireCandidate = (
  candidate: ImportCandidate,
): WireCandidateResult => {
  const customFields = readCustomFields(candidate).filter(({ label }) =>
    label.trim(),
  );
  const { dataBoxes } = candidate.metadata ?? {};
  const metadata =
    customFields.length > 0 || dataBoxes
      ? {
          ...(dataBoxes && { dataBoxes }),
          ...(customFields.length > 0 && { customFields }),
        }
      : undefined;

  return {
    type: candidate.type,
    displayName: candidate.displayName,
    ...(candidate.prefix !== undefined && { prefix: candidate.prefix }),
    ...(candidate.firstName !== undefined && {
      firstName: candidate.firstName,
    }),
    ...(candidate.middleName !== undefined && {
      middleName: candidate.middleName,
    }),
    ...(candidate.lastName !== undefined && { lastName: candidate.lastName }),
    ...(candidate.suffix !== undefined && { suffix: candidate.suffix }),
    ...(candidate.organizationName !== undefined && {
      organizationName: candidate.organizationName,
    }),
    ...(candidate.notes !== undefined && { notes: candidate.notes }),
    ...(candidate.emails !== undefined && { emails: candidate.emails }),
    ...(candidate.phones !== undefined && { phones: candidate.phones }),
    ...(candidate.addresses !== undefined && {
      addresses: candidate.addresses,
    }),
    ...(candidate.tags !== undefined && { tags: candidate.tags }),
    ...(candidate.registrationNumber !== undefined && {
      registrationNumber: candidate.registrationNumber,
    }),
    ...(candidate.taxId !== undefined && { taxId: candidate.taxId }),
    ...(metadata !== undefined && { metadata }),
  };
};
