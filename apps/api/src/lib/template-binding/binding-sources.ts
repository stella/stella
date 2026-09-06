/**
 * The taxonomy for contact/matter data bindings on template fields
 * ({@link FieldSource}). A bound field's value is resolved server-side from a
 * record in the matter at fill time, rather than entered by the person filling.
 *
 * A field is addressed by `(kind, field)` — plus `role` for a party and `ref`
 * for an attorney. `field` is a stable string key: today it names a built-in
 * field; a future org-level field-definition registry will let it hold a
 * property id instead, so the shape is forward-compatible (it mirrors the
 * `@stll/conditions` operand model, which already addresses custom columns by a
 * stable id). Bindings are stored and resolved by these keys, never by a
 * display label, so renaming a label never breaks a saved binding.
 */

import * as v from "valibot";

import {
  WORKSPACE_CONTACT_ROLES,
  type WorkspaceContactRole,
} from "@stll/api-contract";

export { WORKSPACE_CONTACT_ROLES };
export type { WorkspaceContactRole };

/** Which attorney on the matter an `attorney` binding resolves: the client's
 *  responsible/originating attorney, or the matter's lead. */
export const ATTORNEY_REFS = ["responsible", "originating", "lead"] as const;
export type AttorneyRef = (typeof ATTORNEY_REFS)[number];

/** Built-in fields of a contact record (the matter's client, or a party).
 *  Address parts complement the one-line `address`. */
export const CONTACT_FIELDS = [
  "displayName",
  "firstName",
  "lastName",
  "organizationName",
  "email",
  "phone",
  "address",
  "addressStreet",
  "addressCity",
  "addressPostalCode",
  "addressCountry",
  "registrationNumber",
  "taxId",
  "iban",
  "bic",
  "dataBox",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Built-in fields of the matter (workspace) record. */
export const MATTER_FIELDS = [
  "name",
  "reference",
  "billingReference",
  "status",
] as const;
export type MatterField = (typeof MATTER_FIELDS)[number];

/** Built-in fields of a user record (an attorney). */
export const USER_FIELDS = ["name", "email"] as const;
export type UserField = (typeof USER_FIELDS)[number];

/** Built-in fields of the firm (organization) record. Only the name exists in
 *  the data model today; address/registration fields are a later extension. */
export const FIRM_FIELDS = ["name"] as const;
export type FirmField = (typeof FIRM_FIELDS)[number];

/** The source-kind discriminator. */
export const BINDING_SOURCE_KINDS = [
  "contact",
  "party",
  "matter",
  "attorney",
  "firm",
] as const;
export type BindingSourceKind = (typeof BINDING_SOURCE_KINDS)[number];

/**
 * A contact/matter data binding on a template field. Discriminated on `kind`;
 * `field` is the stable key within the resolved record (see module docs).
 */
const workspaceContactRoleSchema = v.picklist(WORKSPACE_CONTACT_ROLES);
const attorneyRefSchema = v.picklist(ATTORNEY_REFS);

export const isWorkspaceContactRole = (
  value: unknown,
): value is WorkspaceContactRole => v.is(workspaceContactRoleSchema, value);

export const isAttorneyRef = (value: unknown): value is AttorneyRef =>
  v.is(attorneyRefSchema, value);

export const fieldSourceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("contact"),
    field: v.picklist(CONTACT_FIELDS),
  }),
  v.strictObject({
    kind: v.literal("party"),
    role: workspaceContactRoleSchema,
    field: v.picklist(CONTACT_FIELDS),
  }),
  v.strictObject({
    kind: v.literal("matter"),
    field: v.picklist(MATTER_FIELDS),
  }),
  v.strictObject({
    kind: v.literal("attorney"),
    ref: attorneyRefSchema,
    field: v.picklist(USER_FIELDS),
  }),
  v.strictObject({
    kind: v.literal("firm"),
    field: v.picklist(FIRM_FIELDS),
  }),
]);

const [contactSource, partySource, matterSource, attorneySource, firmSource] =
  fieldSourceSchema.options;

/** Provider-portable projection of the same discriminated branches. Runtime
 * parsing uses the indexed variant above; tool JSON Schema uses `anyOf` plus
 * single-value enums because providers do not share `oneOf`/`const` support. */
export const fieldSourceToolInputSchema = v.union([
  v.strictObject({
    ...contactSource.entries,
    kind: v.picklist([contactSource.entries.kind.literal]),
  }),
  v.strictObject({
    ...partySource.entries,
    kind: v.picklist([partySource.entries.kind.literal]),
  }),
  v.strictObject({
    ...matterSource.entries,
    kind: v.picklist([matterSource.entries.kind.literal]),
  }),
  v.strictObject({
    ...attorneySource.entries,
    kind: v.picklist([attorneySource.entries.kind.literal]),
  }),
  v.strictObject({
    ...firmSource.entries,
    kind: v.picklist([firmSource.entries.kind.literal]),
  }),
]);

export type FieldSource = v.InferOutput<typeof fieldSourceSchema>;

/**
 * Validate a {@link FieldSource}: a known `kind`, a `field` key allowed for
 * that kind, and (where applicable) a valid `role`/`ref`. Built-in field keys
 * are checked against the per-kind allow-lists; when the registry lands this
 * widens to also accept property ids.
 */
export const isFieldSource = (value: unknown): value is FieldSource =>
  v.is(fieldSourceSchema, value);
