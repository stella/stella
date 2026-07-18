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
export type CatalogField = { key: string; labelKey: CatalogLabelKey };

/** A role/ref picker offered alongside the field picker for the party and
 *  attorney sources. */
type CatalogRole = { value: WorkspaceContactRole; labelKey: CatalogLabelKey };
type CatalogRef = { value: AttorneyRef; labelKey: CatalogLabelKey };

/**
 * One pickable source. Discriminated on `kind` so the per-kind extras are
 * modelled where they exist rather than as always-optional fields: `party`
 * carries `roles`, `attorney` carries `refs`, and the rest carry neither. A new
 * kind then fails typecheck at every consumer instead of silently defaulting.
 */
export type CatalogSource =
  | { kind: "contact"; labelKey: CatalogLabelKey; fields: CatalogField[] }
  | {
      kind: "party";
      labelKey: CatalogLabelKey;
      roles: CatalogRole[];
      fields: CatalogField[];
    }
  | { kind: "matter"; labelKey: CatalogLabelKey; fields: CatalogField[] }
  | {
      kind: "attorney";
      labelKey: CatalogLabelKey;
      refs: CatalogRef[];
      fields: CatalogField[];
    }
  | { kind: "firm"; labelKey: CatalogLabelKey; fields: CatalogField[] };

export type BindingCatalog = { sources: CatalogSource[] };

// Labels reuse the canonical contact/common/party-role keys wherever an
// equivalent exists; only genuinely new concepts mint `templates.binding.*`.
const CONTACT_FIELD_LABELS = {
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
} as const satisfies Record<ContactField, string>;

const MATTER_FIELD_LABELS = {
  name: "common.name",
  reference: "common.reference",
  billingReference: "templates.binding.fieldBillingReference",
  status: "common.status",
} as const satisfies Record<MatterField, string>;

const USER_FIELD_LABELS = {
  name: "common.name",
  email: "common.email",
} as const satisfies Record<UserField, string>;

const FIRM_FIELD_LABELS = {
  name: "common.name",
} as const satisfies Record<FirmField, string>;

const ROLE_LABELS = {
  opposing_party: "workspaces.parties.partyRoles.opposing_party",
  opposing_counsel: "workspaces.parties.partyRoles.opposing_counsel",
  co_counsel: "workspaces.parties.partyRoles.co_counsel",
  witness: "workspaces.parties.partyRoles.witness",
  expert_witness: "workspaces.parties.partyRoles.expert_witness",
  third_party: "workspaces.parties.partyRoles.third_party",
  judge: "workspaces.parties.partyRoles.judge",
  mediator: "workspaces.parties.partyRoles.mediator",
  other: "workspaces.parties.partyRoles.other",
} as const satisfies Record<WorkspaceContactRole, string>;

const ATTORNEY_REF_LABELS = {
  responsible: "contacts.attorneys.responsible",
  originating: "contacts.attorneys.originating",
  lead: "templates.binding.attorneyLead",
} as const satisfies Record<AttorneyRef, string>;

const SOURCE_LABELS = {
  contact: "workspaces.parties.client",
  party: "templates.binding.sourceParty",
  matter: "common.matter",
  attorney: "templates.binding.sourceAttorney",
  firm: "templates.binding.sourceFirm",
} as const satisfies Record<CatalogSource["kind"], string>;

/**
 * Every i18n key the catalog can emit, as a literal union. Flows to the
 * frontend through Eden, where `t(labelKey)` then typechecks against the real
 * message catalog — a stale or values-bearing key fails the web typecheck
 * instead of needing a runtime cast.
 */
export type CatalogLabelKey =
  | (typeof SOURCE_LABELS)[CatalogSource["kind"]]
  | (typeof CONTACT_FIELD_LABELS)[ContactField]
  | (typeof MATTER_FIELD_LABELS)[MatterField]
  | (typeof USER_FIELD_LABELS)[UserField]
  | (typeof FIRM_FIELD_LABELS)[FirmField]
  | (typeof ROLE_LABELS)[WorkspaceContactRole]
  | (typeof ATTORNEY_REF_LABELS)[AttorneyRef];

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
      labelKey: SOURCE_LABELS.contact,
      fields: contactFields(),
    },
    {
      kind: "party",
      labelKey: SOURCE_LABELS.party,
      roles: WORKSPACE_CONTACT_ROLES.map((value) => ({
        value,
        labelKey: ROLE_LABELS[value],
      })),
      fields: contactFields(),
    },
    {
      kind: "matter",
      labelKey: SOURCE_LABELS.matter,
      fields: MATTER_FIELDS.map((key) => ({
        key,
        labelKey: MATTER_FIELD_LABELS[key],
      })),
    },
    {
      kind: "attorney",
      labelKey: SOURCE_LABELS.attorney,
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
      labelKey: SOURCE_LABELS.firm,
      fields: FIRM_FIELDS.map((key) => ({
        key,
        labelKey: FIRM_FIELD_LABELS[key],
      })),
    },
  ],
});
