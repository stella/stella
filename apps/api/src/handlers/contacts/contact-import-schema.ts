import * as v from "valibot";

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
import { MAX_CONTACT_NATIONALITY_CODES } from "@/api/lib/business-registries/nationality-codes";
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

const draftText = v.pipe(v.string(), v.maxLength(DRAFT_TEXT_MAX_CHARS));
const optionalDraftText = v.exactOptional(draftText);

const draftEmailSchema = v.intersect([
  v.pick(contactEmailSchema, ["type", "isPrimary", "label"]),
  v.object({ address: draftText }),
]);

const draftPhoneSchema = v.intersect([
  v.pick(contactPhoneSchema, ["type", "isPrimary", "label"]),
  v.object({ number: draftText }),
]);

const draftAddressSchema = v.intersect([
  v.pick(contactAddressSchema, ["type", "isPrimary", "label"]),
  v.object({
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
const draftCustomFieldSchema = v.intersect([
  v.pick(contactCustomFieldSchema, ["id", "label"]),
  v.object({ value: draftText }),
]);

export const contactImportCandidateSchema = v.object({
  type: createContactTypeSchema,
  displayName: draftText,
  prefix: optionalDraftText,
  firstName: optionalDraftText,
  middleName: optionalDraftText,
  lastName: optionalDraftText,
  suffix: optionalDraftText,
  organizationName: optionalDraftText,
  notes: optionalDraftText,
  emails: v.exactOptional(
    v.pipe(v.array(draftEmailSchema), v.maxLength(DRAFT_LIST_MAX_ITEMS)),
  ),
  phones: v.exactOptional(
    v.pipe(v.array(draftPhoneSchema), v.maxLength(DRAFT_LIST_MAX_ITEMS)),
  ),
  addresses: v.exactOptional(
    v.pipe(v.array(draftAddressSchema), v.maxLength(DRAFT_LIST_MAX_ITEMS)),
  ),
  tags: v.exactOptional(
    v.pipe(v.array(draftText), v.maxLength(DRAFT_LIST_MAX_ITEMS)),
  ),
  registrationNumber: optionalDraftText,
  taxId: optionalDraftText,
  dateOfBirth: v.exactOptional(
    v.union([
      v.strictObject({
        precision: v.literal("year"),
        year: v.pipe(v.number(), v.integer()),
      }),
      v.strictObject({
        precision: v.literal("month"),
        year: v.pipe(v.number(), v.integer()),
        month: v.pipe(v.number(), v.integer()),
      }),
      v.strictObject({
        precision: v.literal("day"),
        year: v.pipe(v.number(), v.integer()),
        month: v.pipe(v.number(), v.integer()),
        day: v.pipe(v.number(), v.integer()),
      }),
    ]),
  ),
  nationalityCodes: v.exactOptional(
    v.pipe(v.array(draftText), v.maxLength(MAX_CONTACT_NATIONALITY_CODES)),
  ),
  metadata: v.exactOptional(
    v.object({
      customFields: v.exactOptional(
        v.pipe(
          v.array(draftCustomFieldSchema),
          v.maxLength(DRAFT_LIST_MAX_ITEMS),
        ),
      ),
    }),
  ),
});

// The draft sub-shapes relax constraints but must keep the persisted key
// sets, so a valid draft is assignable to what the insert expects and a new
// persisted key cannot silently go un-importable.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;

true satisfies SameKeys<v.InferOutput<typeof draftEmailSchema>, ContactEmail>;
true satisfies SameKeys<v.InferOutput<typeof draftPhoneSchema>, ContactPhone>;
true satisfies SameKeys<
  v.InferOutput<typeof draftAddressSchema>,
  ContactAddress
>;
true satisfies SameKeys<
  v.InferOutput<typeof draftCustomFieldSchema>,
  ContactCustomField
>;

/**
 * The contract's scheme list as a fixed tuple, with no default: an omitted
 * scheme must stay a rejection rather than silently become `none`.
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
export const taxIdSchemeSchema = v.union([
  v.literal(TAX_ID_SCHEMES[0]),
  v.literal(TAX_ID_SCHEMES[1]),
]);
