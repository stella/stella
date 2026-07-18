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

/** Non-client party roles on a matter (mirrors the `workspaceContacts.role`
 *  enum). The matter's client is `{ kind: "contact" }`, not a party. */
export const WORKSPACE_CONTACT_ROLES = [
  "opposing_party",
  "opposing_counsel",
  "co_counsel",
  "witness",
  "expert_witness",
  "third_party",
  "judge",
  "mediator",
  "other",
] as const;
export type WorkspaceContactRole = (typeof WORKSPACE_CONTACT_ROLES)[number];

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
export type FieldSource =
  | { kind: "contact"; field: string }
  | { kind: "party"; role: WorkspaceContactRole; field: string }
  | { kind: "matter"; field: string }
  | { kind: "attorney"; ref: AttorneyRef; field: string }
  | { kind: "firm"; field: string };

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = (members: readonly string[], value: unknown): boolean =>
  typeof value === "string" && members.includes(value);

export const isWorkspaceContactRole = (
  value: unknown,
): value is WorkspaceContactRole => isMember(WORKSPACE_CONTACT_ROLES, value);

export const isAttorneyRef = (value: unknown): value is AttorneyRef =>
  isMember(ATTORNEY_REFS, value);

/**
 * Validate a {@link FieldSource}: a known `kind`, a `field` key allowed for
 * that kind, and (where applicable) a valid `role`/`ref`. Built-in field keys
 * are checked against the per-kind allow-lists; when the registry lands this
 * widens to also accept property ids.
 */
export const isFieldSource = (value: unknown): value is FieldSource => {
  if (!isRecordLike(value) || typeof value["field"] !== "string") {
    return false;
  }
  switch (value["kind"]) {
    case "contact":
      return isMember(CONTACT_FIELDS, value["field"]);
    case "party":
      return (
        isWorkspaceContactRole(value["role"]) &&
        isMember(CONTACT_FIELDS, value["field"])
      );
    case "matter":
      return isMember(MATTER_FIELDS, value["field"]);
    case "attorney":
      return (
        isAttorneyRef(value["ref"]) && isMember(USER_FIELDS, value["field"])
      );
    case "firm":
      return isMember(FIRM_FIELDS, value["field"]);
    default:
      return false;
  }
};
