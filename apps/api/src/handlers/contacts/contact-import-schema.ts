import { t } from "elysia";
import type { Static } from "elysia";

import type { CONTACT_IMPORT_TAX_ID_SCHEMES } from "@stll/api-contract";

import {
  contactAddressSchema,
  contactCustomFieldSchema,
  contactEmailSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import type {
  ContactAddress,
  ContactCustomField,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { createContactTypeSchema } from "@/api/handlers/contacts/schema";
import { LIMITS } from "@/api/lib/limits";

/**
 * Wire shape of one reviewed contact, without the caller-generated id.
 *
 * This is deliberately a DRAFT schema: it fixes the structure (which fields
 * exist, arrays vs strings, the type enum) and bounds payload size, but it
 * does not repeat the content rules (email format, per-field lengths, a
 * non-empty display name). Those belong to `validateContactImportCandidate`,
 * which reports them per row so a reviewer can fix the row; a schema-level
 * rejection would turn every fixable row into a 400 for the whole batch. The
 * commit handler runs the same validator and skips rows with issues, so
 * relaxing the wire schema never lets an invalid row reach the table.
 */
const DRAFT_TEXT_MAX_CHARS = LIMITS.contactsImportNotesMaxChars;
const DRAFT_LIST_MAX_ITEMS = 200;

const draftText = t.String({ maxLength: DRAFT_TEXT_MAX_CHARS });
const optionalDraftText = t.Optional(draftText);

const draftEmailSchema = t.Composite([
  t.Pick(contactEmailSchema, ["type", "isPrimary", "label"]),
  t.Object({ address: draftText }),
]);

const draftPhoneSchema = t.Composite([
  t.Pick(contactPhoneSchema, ["type", "isPrimary", "label"]),
  t.Object({ number: draftText }),
]);

const draftAddressSchema = t.Composite([
  t.Pick(contactAddressSchema, ["type", "isPrimary", "label"]),
  t.Object({
    line1: draftText,
    line2: optionalDraftText,
    city: optionalDraftText,
    state: optionalDraftText,
    postalCode: optionalDraftText,
    country: optionalDraftText,
  }),
]);

// Custom-field ids and labels are client-derived identifiers, not reviewed
// content, so they keep the persisted bounds; only the value is a draft.
const draftCustomFieldSchema = t.Composite([
  t.Pick(contactCustomFieldSchema, ["id", "label"]),
  t.Object({ value: draftText }),
]);

export const contactImportCandidateSchema = t.Object({
  type: createContactTypeSchema,
  displayName: draftText,
  prefix: optionalDraftText,
  firstName: optionalDraftText,
  middleName: optionalDraftText,
  lastName: optionalDraftText,
  suffix: optionalDraftText,
  organizationName: optionalDraftText,
  notes: optionalDraftText,
  emails: t.Optional(
    t.Array(draftEmailSchema, { maxItems: DRAFT_LIST_MAX_ITEMS }),
  ),
  phones: t.Optional(
    t.Array(draftPhoneSchema, { maxItems: DRAFT_LIST_MAX_ITEMS }),
  ),
  addresses: t.Optional(
    t.Array(draftAddressSchema, { maxItems: DRAFT_LIST_MAX_ITEMS }),
  ),
  tags: t.Optional(t.Array(draftText, { maxItems: DRAFT_LIST_MAX_ITEMS })),
  registrationNumber: optionalDraftText,
  taxId: optionalDraftText,
  metadata: t.Optional(
    t.Object({
      customFields: t.Optional(
        t.Array(draftCustomFieldSchema, { maxItems: DRAFT_LIST_MAX_ITEMS }),
      ),
    }),
  ),
});

export type ContactImportCandidateInput = Static<
  typeof contactImportCandidateSchema
>;

// The draft sub-shapes relax constraints but must keep the persisted key
// sets, so a valid draft is assignable to what the insert expects and a new
// persisted key cannot silently go un-importable.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;

true satisfies SameKeys<Static<typeof draftEmailSchema>, ContactEmail>;
true satisfies SameKeys<Static<typeof draftPhoneSchema>, ContactPhone>;
true satisfies SameKeys<Static<typeof draftAddressSchema>, ContactAddress>;
true satisfies SameKeys<
  Static<typeof draftCustomFieldSchema>,
  ContactCustomField
>;

/**
 * The contract's scheme list as a fixed tuple. `t.Union` over a mapped array
 * (`SCHEMES.map(t.Literal)`) infers `Static` as `never`, so no caller can name
 * a scheme at all; `t.UnionEnum` types it but stamps a `default`, and an
 * omitted scheme must stay a rejection rather than silently become `none`.
 * `satisfies` binds this list to the contract's: adding a scheme there fails
 * to compile here until this union learns about it.
 */
const TAX_ID_SCHEMES = [
  "none",
  "br_cpf_cnpj",
] as const satisfies typeof CONTACT_IMPORT_TAX_ID_SCHEMES;

/**
 * Which validator, if any, the batch's tax ids must satisfy. `br_cpf_cnpj`
 * requires a tax id, checks CPF/CNPJ checksums, stores the bare digits, and
 * rejects a row whose declared type disagrees with the number's kind; `none`
 * stores the value as given and applies no tax-id uniqueness (ordinary create
 * permits duplicates).
 */
export const taxIdSchemeSchema = t.Union([
  t.Literal(TAX_ID_SCHEMES[0]),
  t.Literal(TAX_ID_SCHEMES[1]),
]);
