import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { contactSearchableText } from "@/api/lib/search/contact-searchable-text";
import {
  buildSearchPreviewPassages,
  buildSearchPreviewPassageValueRows,
} from "@/api/lib/search/preview-passages";

type ContactSearchProjectionSource = {
  id: SafeId<"contact">;
  organizationId: SafeId<"organization">;
  type: "person" | "organization";
  prefix: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  organizationName: string | null;
  displayName: string;
  notes: string | null;
  emails: ContactEmail[] | null;
  phones: ContactPhone[] | null;
  addresses: ContactAddress[] | null;
  tags: string[] | null;
  registrationNumber: string | null;
  taxId: string | null;
  currency: string | null;
  updatedAt: Date;
};

/** Persist new contacts' derived global-search rows in the caller's transaction. */
export const insertContactSearchProjections = async (
  tx: Transaction,
  contacts: readonly ContactSearchProjectionSource[],
): Promise<void> => {
  if (contacts.length === 0) {
    return;
  }

  const projections = contacts.map((contact) => {
    const searchableText = contactSearchableText(contact);
    return {
      contact,
      previewGeneration: Bun.randomUUIDv7(),
      previewPassages: buildSearchPreviewPassages(
        contact.displayName,
        searchableText,
      ),
      searchableText,
    };
  });

  const documentRows = projections.map(
    ({ contact, previewGeneration, searchableText }) => sql`(
      ${contact.id},
      ${contact.organizationId},
      ${contact.type},
      ${contact.displayName},
      ${searchableText},
      ${previewGeneration}::uuid,
      to_tsvector(
        'simple',
        unaccent(arabic_normalize(
          coalesce(${contact.displayName}, '') || ' ' ||
          coalesce(${searchableText}, '')
        ))
      ),
      ${contact.updatedAt}
    )`,
  );

  await tx.execute(sql`
    INSERT INTO contact_search_documents (
      contact_id,
      organization_id,
      contact_type,
      title,
      searchable_text,
      preview_generation,
      tsv,
      updated_at
    ) VALUES ${sql.join(documentRows, sql`, `)}
  `);

  const previewPassageRows = projections.map(
    ({ contact, previewGeneration, previewPassages }) =>
      buildSearchPreviewPassageValueRows({
        generation: previewGeneration,
        leadingValues: [sql`${contact.id}`, sql`${contact.organizationId}`],
        passages: previewPassages,
        regconfig: sql`'simple'`,
        useUnaccent: true,
      }),
  );
  await tx.execute(sql`
    INSERT INTO contact_search_document_preview_passages (
      contact_id,
      organization_id,
      generation,
      ordinal,
      content,
      tsv
    ) VALUES ${sql.join(previewPassageRows, sql`, `)}
  `);
};
