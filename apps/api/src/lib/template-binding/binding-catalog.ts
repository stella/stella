/**
 * The binding catalog: the set of `(source, field)` options a template author
 * can bind a field to, with an i18n label key per entry. Built from the static
 * {@link binding-sources} taxonomy today; when an org-level field-definition
 * registry lands, custom fields are appended here (carrying a literal `label`
 * instead of a `labelKey`) and the authoring picker needs no change.
 *
 * Label keys reuse the canonical contact/common i18n keys where an equivalent
 * already exists (so the i18n overlap gate stays clean) and add
 * `templates.binding.*` keys for the rest.
 */

import {
  ATTORNEY_REFS,
  type AttorneyRef,
  CONTACT_FIELDS,
  type ContactField,
  FIRM_FIELDS,
  type FirmField,
  MATTER_FIELDS,
  type MatterField,
  USER_FIELDS,
  type UserField,
  WORKSPACE_CONTACT_ROLES,
  type WorkspaceContactRole,
} from "./binding-sources";

/** One bindable field within a source. `labelKey` is an i18n key resolved by
 *  the frontend; a future custom field would instead carry a literal `label`. */
export type CatalogField = { key: string; labelKey: string };

/** A role/ref picker offered alongside the field picker for the party and
 *  attorney sources. */
type CatalogRole = { value: WorkspaceContactRole; labelKey: string };
type CatalogRef = { value: AttorneyRef; labelKey: string };

/**
 * One pickable source. Discriminated on `kind` so the per-kind extras are
 * modelled where they exist rather than as always-optional fields: `party`
 * carries `roles`, `attorney` carries `refs`, and the rest carry neither. A new
 * kind then fails typecheck at every consumer instead of silently defaulting.
 */
export type CatalogSource =
  | { kind: "contact"; labelKey: string; fields: CatalogField[] }
  | {
      kind: "party";
      labelKey: string;
      roles: CatalogRole[];
      fields: CatalogField[];
    }
  | { kind: "matter"; labelKey: string; fields: CatalogField[] }
  | {
      kind: "attorney";
      labelKey: string;
      refs: CatalogRef[];
      fields: CatalogField[];
    }
  | { kind: "firm"; labelKey: string; fields: CatalogField[] };

export type BindingCatalog = { sources: CatalogSource[] };

// Labels reuse the canonical contact/common/party-role keys wherever an
// equivalent exists; only genuinely new concepts mint `templates.binding.*`.
const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  displayName: "contacts.fields.displayName",
  firstName: "contacts.fields.firstName",
  lastName: "contacts.fields.lastName",
  organizationName: "common.organizationName",
  email: "common.email",
  phone: "contacts.columns.phone",
  address: "common.anonymizationLabels.address",
  addressStreet: "contacts.fields.billingAddressLine1",
  addressCity: "contacts.fields.billingAddressCity",
  addressPostalCode: "contacts.fields.billingAddressPostalCode",
  addressCountry: "common.country",
  registrationNumber: "contacts.fields.registrationNumber",
  taxId: "contacts.fields.taxId",
  iban: "contacts.fields.bankAccountIban",
  bic: "contacts.fields.bankAccountBic",
  dataBox: "contacts.communication.dataBoxPlaceholder",
};

const MATTER_FIELD_LABELS: Record<MatterField, string> = {
  name: "common.name",
  reference: "common.reference",
  billingReference: "templates.binding.fieldBillingReference",
  status: "common.status",
};

const USER_FIELD_LABELS: Record<UserField, string> = {
  name: "common.name",
  email: "common.email",
};

const FIRM_FIELD_LABELS: Record<FirmField, string> = {
  name: "common.name",
};

const ROLE_LABELS: Record<WorkspaceContactRole, string> = {
  opposing_party: "workspaces.parties.partyRoles.opposing_party",
  opposing_counsel: "workspaces.parties.partyRoles.opposing_counsel",
  co_counsel: "workspaces.parties.partyRoles.co_counsel",
  witness: "workspaces.parties.partyRoles.witness",
  expert_witness: "workspaces.parties.partyRoles.expert_witness",
  third_party: "workspaces.parties.partyRoles.third_party",
  judge: "workspaces.parties.partyRoles.judge",
  mediator: "workspaces.parties.partyRoles.mediator",
  other: "workspaces.parties.partyRoles.other",
};

const ATTORNEY_REF_LABELS: Record<AttorneyRef, string> = {
  responsible: "contacts.attorneys.responsible",
  originating: "contacts.attorneys.originating",
  lead: "templates.binding.attorneyLead",
};

const contactFields = (): CatalogField[] =>
  CONTACT_FIELDS.map((key) => ({ key, labelKey: CONTACT_FIELD_LABELS[key] }));

/**
 * Build the binding catalog. Static today (built from the binding-sources
 * taxonomy); a future custom-field registry can append per-org definitions by
 * adding a parameter here without changing any consumer.
 */
export const buildBindingCatalog = (): BindingCatalog => ({
  sources: [
    {
      kind: "contact",
      labelKey: "workspaces.parties.client",
      fields: contactFields(),
    },
    {
      kind: "party",
      labelKey: "templates.binding.sourceParty",
      roles: WORKSPACE_CONTACT_ROLES.map((value) => ({
        value,
        labelKey: ROLE_LABELS[value],
      })),
      fields: contactFields(),
    },
    {
      kind: "matter",
      labelKey: "common.matter",
      fields: MATTER_FIELDS.map((key) => ({
        key,
        labelKey: MATTER_FIELD_LABELS[key],
      })),
    },
    {
      kind: "attorney",
      labelKey: "templates.binding.sourceAttorney",
      refs: ATTORNEY_REFS.map((value) => ({
        value,
        labelKey: ATTORNEY_REF_LABELS[value],
      })),
      fields: USER_FIELDS.map((key) => ({
        key,
        labelKey: USER_FIELD_LABELS[key],
      })),
    },
    {
      kind: "firm",
      labelKey: "templates.binding.sourceFirm",
      fields: FIRM_FIELDS.map((key) => ({
        key,
        labelKey: FIRM_FIELD_LABELS[key],
      })),
    },
  ],
});
