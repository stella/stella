import { Result, panic } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { validateCnpj } from "@stll/business-registries/cnpj";
import { validateCpf } from "@stll/business-registries/cpf";

import { contacts } from "@/api/db/schema";
import {
  contactAddressSchema,
  contactEmailSchema,
  contactMetadataSchema,
} from "@/api/db/schema-validators";
import {
  checkContactsCountLimit,
  insertContactRow,
} from "@/api/handlers/contacts/create";
import type { CreateContactBody } from "@/api/handlers/contacts/create";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { flushContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";

const onlyDigits = (value: string): string => value.replaceAll(/\D/gu, "");

const importContactRowSchema = t.Object({
  id: tSafeId("contact"),
  displayName: t.String({ minLength: 1, maxLength: 512 }),
  taxId: t.String({ minLength: 1, maxLength: 64 }),
  emails: t.Optional(t.Array(contactEmailSchema, { maxItems: 1 })),
  addresses: t.Optional(t.Array(contactAddressSchema, { maxItems: 1 })),
  metadata: t.Optional(contactMetadataSchema),
});

type ImportContactRow = Static<typeof importContactRowSchema>;

const importContactsBodySchema = t.Object({
  rows: t.Array(importContactRowSchema, {
    maxItems: LIMITS.contactsImportRowsMax,
  }),
});

type ImportSkipReason =
  | "duplicate_tax_id"
  | "invalid_tax_id"
  | "contacts_limit_reached";

type ImportResultRow =
  | { index: number; status: "created"; contactId: SafeId<"contact"> }
  | { index: number; status: "skipped"; reason: ImportSkipReason };

// Classifies a row's taxId into a Contact `type` and validates its checksum
// server-side (the authoritative boundary check) — the client only does a
// cheap digit-count check for instant preview feedback, so this must not
// trust anything beyond the raw string.
const classifyTaxId = (
  taxId: string,
): { digits: string; type: "person" | "organization" } | null => {
  const digits = onlyDigits(taxId);
  if (digits.length === 11 && validateCpf(digits)) {
    return { digits, type: "person" };
  }
  if (digits.length === 14 && validateCnpj(digits)) {
    return { digits, type: "organization" };
  }
  return null;
};

const toCreateContactBody = (
  row: ImportContactRow,
  classification: { digits: string; type: "person" | "organization" },
): CreateContactBody => ({
  id: row.id,
  type: classification.type,
  displayName: row.displayName,
  taxId: classification.digits,
  ...(classification.type === "organization" && {
    organizationName: row.displayName,
  }),
  ...(row.emails && { emails: row.emails }),
  ...(row.addresses && { addresses: row.addresses }),
  ...(row.metadata && { metadata: row.metadata }),
});

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "covered", by: "save_contact" },
  body: importContactsBodySchema,
} satisfies HandlerConfig;

const importContacts = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const results = yield* Result.await(
      safeDb(async (tx): Promise<ImportResultRow[] | null> => {
        const { total } = await checkContactsCountLimit(tx, organizationId, 0);
        if (total >= LIMITS.contactsCount) {
          return null;
        }

        const remainingCapacity = LIMITS.contactsCount - total;

        const existingTaxIdRows = await tx
          .select({ taxId: contacts.taxId })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              isNotNull(contacts.taxId),
            ),
          );

        const seenTaxIds = new Set(
          existingTaxIdRows
            .map((row) => onlyDigits(row.taxId ?? ""))
            .filter((digits) => digits.length > 0),
        );

        const rowResults: ImportResultRow[] = [];
        let createdCount = 0;

        for (const [index, row] of body.rows.entries()) {
          const classification = classifyTaxId(row.taxId);
          if (!classification) {
            rowResults.push({
              index,
              status: "skipped",
              reason: "invalid_tax_id",
            });
            continue;
          }

          if (seenTaxIds.has(classification.digits)) {
            rowResults.push({
              index,
              status: "skipped",
              reason: "duplicate_tax_id",
            });
            continue;
          }

          if (createdCount >= remainingCapacity) {
            rowResults.push({
              index,
              status: "skipped",
              reason: "contacts_limit_reached",
            });
            continue;
          }

          seenTaxIds.add(classification.digits);

          // oxlint-disable-next-line no-await-in-loop -- sequential inserts inside one transaction, bounded by contactsImportRowsMax
          const inserted = await insertContactRow({
            tx,
            organizationId,
            userId: user.id,
            recordAuditEvent,
            body: toCreateContactBody(row, classification),
          });

          const created = inserted ?? panic("Contact insert returned no row");
          createdCount += 1;
          rowResults.push({
            index,
            status: "created",
            contactId: created.id,
          });
        }

        return rowResults;
      }),
    );

    if (results === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Contacts limit reached" }),
      );
    }

    const createdContactIds = results
      .filter((result) => result.status === "created")
      .map((result) => result.contactId);

    if (createdContactIds.length > 0) {
      flushContactSearchRepairs(createdContactIds).catch(captureError);
    }

    return Result.ok({ results });
  },
);

export default importContacts;
