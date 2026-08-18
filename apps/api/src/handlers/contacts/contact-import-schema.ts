import { t } from "elysia";
import type { Static } from "elysia";

import { CONTACT_IMPORT_TAX_ID_SCHEMES } from "@stll/api-contract";

import {
  contactAddressSchema,
  contactEmailSchema,
  contactMetadataSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { createContactTypeSchema } from "@/api/handlers/contacts/schema";
import { LIMITS } from "@/api/lib/limits";

/**
 * One reviewed contact, without the caller-generated id. Mirrors the
 * persisted contact fields an import may set; limits match
 * `createContactBodySchema` so a row that passes here also passes single
 * create. The commit handler composes its own `id` on top and the validate
 * handler takes this shape as-is, so the two cannot drift.
 */
export const contactImportCandidateSchema = t.Object({
  type: createContactTypeSchema,
  displayName: t.String({ minLength: 1, maxLength: 512 }),
  prefix: t.Optional(t.String({ maxLength: 32 })),
  firstName: t.Optional(t.String({ maxLength: 256 })),
  middleName: t.Optional(t.String({ maxLength: 256 })),
  lastName: t.Optional(t.String({ maxLength: 256 })),
  suffix: t.Optional(t.String({ maxLength: 32 })),
  organizationName: t.Optional(t.String({ maxLength: 512 })),
  notes: t.Optional(
    t.String({ maxLength: LIMITS.contactsImportNotesMaxChars }),
  ),
  emails: t.Optional(t.Array(contactEmailSchema, { maxItems: 20 })),
  phones: t.Optional(t.Array(contactPhoneSchema, { maxItems: 20 })),
  addresses: t.Optional(t.Array(contactAddressSchema, { maxItems: 10 })),
  tags: t.Optional(t.Array(t.String({ maxLength: 256 }), { maxItems: 50 })),
  registrationNumber: t.Optional(t.String({ maxLength: 64 })),
  taxId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  metadata: t.Optional(contactMetadataSchema),
});

export type ContactImportCandidateInput = Static<
  typeof contactImportCandidateSchema
>;

/**
 * Which validator, if any, the batch's tax ids must satisfy. `br_cpf_cnpj`
 * checks CPF/CNPJ checksums, stores the bare digits, and rejects a row whose
 * declared type disagrees with the number's kind; `none` stores the value as
 * given and applies no tax-id uniqueness (ordinary create permits duplicates).
 */
export const taxIdSchemeSchema = t.Union(
  CONTACT_IMPORT_TAX_ID_SCHEMES.map((scheme) => t.Literal(scheme)),
);
