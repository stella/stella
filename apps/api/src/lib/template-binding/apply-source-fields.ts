/**
 * Resolve data-bound fields ({@link FieldMeta.source}) before any other fill
 * step. A bound field's value is derived from a record in the matter (the
 * client contact, a party contact, the matter itself, an attorney, or the
 * firm), not entered by the person filling, so this runs first in the manifest
 * pipeline: composites, formulas, dependent selects, conditions, and date
 * formatting downstream all see the resolved value.
 *
 * A field is left untouched when its source record is absent (a transient fill,
 * a personal matter with no client, a role with no contact, a removed attorney)
 * or when the field is empty on that record, mirroring how an unmatched lookup
 * leaves its field unfilled. The resolvers are pure — they take structural
 * `*SourceRecord` shapes, not Drizzle rows — so they unit-test without a
 * database; {@link build-binding-context} maps the matter's records onto them.
 */

import { resolvePath } from "@stll/template-conditions";

import type {
  BankAccount,
  BillingAddress,
  ContactAddress,
  ContactDataBox,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { replaceResolvedValue } from "@/api/handlers/docx/composite-fields";
import type { FieldMeta } from "@/api/handlers/docx/types";

import type {
  AttorneyRef,
  FieldSource,
  WorkspaceContactRole,
} from "./binding-sources";

/** The subset of contact columns a contact/party-sourced field resolves from. */
export type ContactSourceRecord = {
  type: "person" | "organization";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  emails: ContactEmail[] | null;
  phones: ContactPhone[] | null;
  addresses: ContactAddress[] | null;
  billingAddress: BillingAddress | null;
  registrationNumber: string | null;
  taxId: string | null;
  bankAccounts: BankAccount[] | null;
  dataBoxes: ContactDataBox[] | null;
};

/** The subset of matter (workspace) columns a matter-sourced field resolves
 *  from. */
export type MatterSourceRecord = {
  name: string | null;
  reference: string | null;
  billingReference: string | null;
  status: string | null;
};

/** The subset of user columns an attorney-sourced field resolves from. */
export type UserSourceRecord = {
  name: string | null;
  email: string | null;
  preferredName: string | null;
};

/** The subset of organization columns a firm-sourced field resolves from. */
export type FirmSourceRecord = {
  name: string | null;
};

/**
 * The records referenced by a manifest's bound fields, resolved once per fill.
 * `parties` is keyed by role and `attorneys` by ref; a key is absent when no
 * record could be resolved (no contact in that role, a removed attorney), which
 * leaves the bound field unfilled.
 */
export type BindingContext = {
  client: ContactSourceRecord | null;
  parties: Partial<Record<WorkspaceContactRole, ContactSourceRecord>>;
  matter: MatterSourceRecord | null;
  attorneys: Partial<Record<AttorneyRef, UserSourceRecord>>;
  firm: FirmSourceRecord | null;
};

/** A context with no records: every bound field is left unfilled. */
export const EMPTY_BINDING_CONTEXT: BindingContext = {
  client: null,
  parties: {},
  matter: null,
  attorneys: {},
  firm: null,
};

const nonEmpty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** The primary entry of a list (email/phone/address/data-box), else the first;
 *  `undefined` for an empty or absent list. */
const primaryOrFirst = <T extends { isPrimary?: boolean }>(
  items: readonly T[] | null,
): T | undefined => items?.find((item) => item.isPrimary) ?? items?.at(0);

type AddressParts = {
  line1?: string | undefined;
  line2?: string | undefined;
  city?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
};

/** The contact's primary-or-first postal address, falling back to its billing
 *  address; an empty object when it has neither. */
const primaryAddress = (record: ContactSourceRecord): AddressParts =>
  primaryOrFirst(record.addresses) ?? record.billingAddress ?? {};

/** Render an address as a single line — street lines, then "postcode city",
 *  then country — dropping empty parts. A locale-aware postal layout is a
 *  later refinement; this is a sensible default for a common address. */
const formatAddress = (address: AddressParts): string =>
  [
    nonEmpty(address.line1),
    nonEmpty(address.line2),
    nonEmpty(
      [nonEmpty(address.postalCode), nonEmpty(address.city)]
        .filter((part): part is string => part !== null)
        .join(" "),
    ),
    nonEmpty(address.country),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

export const resolveContactField = (
  record: ContactSourceRecord,
  field: string,
): string | null => {
  switch (field) {
    case "displayName":
      return nonEmpty(record.displayName);
    case "firstName":
      return nonEmpty(record.firstName);
    case "lastName":
      return nonEmpty(record.lastName);
    case "organizationName":
      return nonEmpty(record.organizationName);
    case "email":
      return nonEmpty(primaryOrFirst(record.emails)?.address);
    case "phone":
      return nonEmpty(primaryOrFirst(record.phones)?.number);
    case "address":
      return nonEmpty(formatAddress(primaryAddress(record)));
    case "addressStreet":
      return nonEmpty(primaryAddress(record).line1);
    case "addressCity":
      return nonEmpty(primaryAddress(record).city);
    case "addressPostalCode":
      return nonEmpty(primaryAddress(record).postalCode);
    case "addressCountry":
      return nonEmpty(primaryAddress(record).country);
    case "registrationNumber":
      return nonEmpty(record.registrationNumber);
    case "taxId":
      return nonEmpty(record.taxId);
    // Bank accounts carry no `isPrimary`, so the first account is the
    // deterministic pick (primary-or-first degenerates to first).
    case "iban":
      return nonEmpty(record.bankAccounts?.at(0)?.iban);
    case "bic":
      return nonEmpty(record.bankAccounts?.at(0)?.bic);
    case "dataBox":
      return nonEmpty(primaryOrFirst(record.dataBoxes)?.id);
    default:
      return null;
  }
};

export const resolveMatterField = (
  record: MatterSourceRecord,
  field: string,
): string | null => {
  switch (field) {
    case "name":
      return nonEmpty(record.name);
    case "reference":
      return nonEmpty(record.reference);
    case "billingReference":
      return nonEmpty(record.billingReference);
    case "status":
      return nonEmpty(record.status);
    default:
      return null;
  }
};

export const resolveAttorneyField = (
  record: UserSourceRecord,
  field: string,
): string | null => {
  switch (field) {
    case "name":
      return nonEmpty(record.name) ?? nonEmpty(record.preferredName);
    case "email":
      return nonEmpty(record.email);
    default:
      return null;
  }
};

export const resolveFirmField = (
  record: FirmSourceRecord,
  field: string,
): string | null => {
  switch (field) {
    case "name":
      return nonEmpty(record.name);
    default:
      return null;
  }
};

/** Resolve one bound field from the in-scope context, dispatching by source
 *  kind to the right record and resolver; null when the record is absent or the
 *  field is empty on it. */
const resolveSource = (
  source: FieldSource,
  context: BindingContext,
): string | null => {
  switch (source.kind) {
    case "contact":
      return context.client === null
        ? null
        : resolveContactField(context.client, source.field);
    case "party": {
      const party = context.parties[source.role];
      return party === undefined
        ? null
        : resolveContactField(party, source.field);
    }
    case "matter":
      return context.matter === null
        ? null
        : resolveMatterField(context.matter, source.field);
    case "attorney": {
      const attorney = context.attorneys[source.ref];
      return attorney === undefined
        ? null
        : resolveAttorneyField(attorney, source.field);
    }
    case "firm":
      return context.firm === null
        ? null
        : resolveFirmField(context.firm, source.field);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};

/**
 * Fill data-bound fields from the in-scope context, mutating `values` in place.
 * Skips a field that already carries a value (an explicit override wins) and any
 * field whose source record is absent or empty for it. No-op without a manifest.
 * Bound fields are scalar (one client/matter/firm, one contact per role), so a
 * `{{#each}}` loop-item path simply finds no target and is left unfilled.
 */
export const applySourceFields = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
  context: BindingContext,
): void => {
  if (manifest === null) {
    return;
  }
  for (const field of manifest.fields) {
    const { source } = field;
    if (source === undefined) {
      continue;
    }
    const existing = resolvePath(field.path, values);
    if (existing !== undefined && existing !== null && existing !== "") {
      continue;
    }
    const resolved = resolveSource(source, context);
    if (resolved === null) {
      continue;
    }
    replaceResolvedValue(values, field.path, resolved);
  }
};
