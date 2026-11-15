import { panic } from "better-result";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import * as v from "valibot";

import type { ContactImportTaxIdScheme } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  type ContactImportReceiptResult,
  contactImportRequests,
  contacts,
} from "@/api/db/schema";
import { lockContactCapacity } from "@/api/handlers/contacts/contact-capacity";
import { mintContactId } from "@/api/handlers/contacts/contact-id";
import {
  contactImportSkipReason,
  importedTaxIdentifiers,
  validateContactImportCandidates,
} from "@/api/handlers/contacts/contact-import-file";
import type { ContactImportCandidate } from "@/api/handlers/contacts/contact-import-file";
import { fingerprintContactImport } from "@/api/handlers/contacts/contact-import-receipt";
import {
  contactImportCandidateSchema,
  taxIdSchemeSchema,
} from "@/api/handlers/contacts/contact-import-schema";
import { normalizeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import { dateOfBirthToColumns } from "@/api/handlers/contacts/person-details";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  externalRefKey,
  externalRefSchema,
} from "@/api/lib/imports/external-ref";
import type { ExternalRef } from "@/api/lib/imports/external-ref";
import {
  externalRefValues,
  readExternalRefIds,
  writeImportedContacts,
} from "@/api/lib/imports/upsert-by-external-id";
import { LIMITS } from "@/api/lib/limits";

// The reviewed row plus, optionally, its identity in the system it came
// from. The field set itself lives in `contact-import-schema.ts`, shared with
// the validate handler. The strict boundary rejects caller-selected persisted
// identifiers: the server mints every new contact id.
export const importContactRowSchema = v.strictObject({
  ...contactImportCandidateSchema.entries,
  external: v.optional(externalRefSchema),
});

export const importContactsBodySchema = v.object({
  importRequestId: resourceIdSchema("contactImportRequest"),
  taxIdScheme: taxIdSchemeSchema,
  rows: v.pipe(
    v.array(importContactRowSchema),
    v.maxLength(LIMITS.contactsImportRowsMax),
  ),
});

type ImportSkipReason =
  ContactImportReceiptResult["results"][number] extends infer R
    ? R extends { status: "skipped"; reason: infer Reason }
      ? Reason
      : never
    : never;

type ImportResultRow = ContactImportReceiptResult["results"][number];

type ValidatedImportRow = {
  index: number;
  id: SafeId<"contact">;
  external: ExternalRef | null;
  contact: ContactImportCandidate;
  /** Normalized digits under `br_cpf_cnpj`; null when no scheme dedupes. */
  dedupeTaxId: string | null;
};

/**
 * A row cleared for writing. One that matches a stored contact by ref
 * updates it under the stored id; every other row is new and keeps the
 * server-minted id.
 */
type PlannedImportRow = ValidatedImportRow & { updatesStoredContact: boolean };

type ImportBody = v.InferOutput<typeof importContactsBodySchema>;

type ImportRowRuling =
  | { type: "accept"; row: ValidatedImportRow }
  | { type: "skip"; reason: ImportSkipReason };

/**
 * Apply the shared batch identity checks, then drop repeats of an external
 * ref or scheme-specific tax id; the first occurrence wins.
 */
const validateImportRows = (
  body: ImportBody,
  resultByIndex: Map<number, ImportResultRow>,
): ValidatedImportRow[] => {
  const seenExternalRefs = new Set<string>();
  const seenTaxIds = new Set<string>();
  const validatedBatch = validateContactImportCandidates({
    candidates: body.rows.map(({ external: _, ...candidate }) => candidate),
    rowNumbers: body.rows.map((_, index) => index + 1),
    taxIdScheme: body.taxIdScheme,
  });

  const rule = (
    index: number,
    { external }: ImportBody["rows"][number],
  ): ImportRowRuling => {
    const { contact, issues } =
      validatedBatch.at(index) ??
      panic("Contact import validation omitted a row");
    if (issues.length > 0) {
      return { type: "skip", reason: contactImportSkipReason(issues) };
    }
    const externalKey =
      external === undefined ? null : externalRefKey(external);
    if (externalKey !== null && seenExternalRefs.has(externalKey)) {
      return { type: "skip", reason: "duplicate_external_ref" };
    }
    // Under `br_cpf_cnpj` the validator has normalized the tax id to
    // digits and guaranteed its presence, so it is the dedupe key.
    const dedupeTaxId =
      body.taxIdScheme === "br_cpf_cnpj" ? (contact.taxId ?? null) : null;
    if (dedupeTaxId !== null && seenTaxIds.has(dedupeTaxId)) {
      return { type: "skip", reason: "duplicate_tax_id" };
    }
    if (externalKey !== null) {
      seenExternalRefs.add(externalKey);
    }
    if (dedupeTaxId !== null) {
      seenTaxIds.add(dedupeTaxId);
    }
    return {
      type: "accept",
      row: {
        index,
        id: mintContactId(),
        external: external ?? null,
        contact,
        dedupeTaxId,
      },
    };
  };

  const validatedRows: ValidatedImportRow[] = [];
  for (const [index, row] of body.rows.entries()) {
    const ruling = rule(index, row);
    if (ruling.type === "skip") {
      resultByIndex.set(index, {
        index,
        status: "skipped",
        reason: ruling.reason,
      });
      continue;
    }
    validatedRows.push(ruling.row);
  }
  return validatedRows;
};

export const contactIdCollisionCondition = (
  organizationId: SafeId<"organization">,
  candidateIds: SafeId<"contact">[],
) =>
  and(
    eq(contacts.organizationId, organizationId),
    inArray(contacts.id, candidateIds),
  ) ?? panic("Contact collision condition is empty");

type PlanImportWritesOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  validatedRows: readonly ValidatedImportRow[];
  resultByIndex: Map<number, ImportResultRow>;
};

/**
 * Rows that will be written, after the stored-state rules: a row whose ref
 * matches a stored contact updates it and takes no capacity; a new row must
 * not reuse a stored contact id or tax id and must fit the capacity left.
 */
const planImportWrites = async ({
  tx,
  organizationId,
  validatedRows,
  resultByIndex,
}: PlanImportWritesOptions): Promise<PlannedImportRow[]> => {
  const existingIdByRef = await readExternalRefIds({
    tx,
    table: contacts,
    organizationId,
    refs: validatedRows.flatMap(({ external }) =>
      external === null ? [] : [external],
    ),
  });

  const candidateIds = validatedRows.map(({ id }) => id);
  const existingIds =
    candidateIds.length === 0
      ? []
      : await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(contactIdCollisionCondition(organizationId, candidateIds));
  const existingIdSet = new Set(existingIds.map(({ id }) => id));

  const candidateTaxIds = validatedRows.flatMap(({ dedupeTaxId }) =>
    dedupeTaxId === null ? [] : [dedupeTaxId],
  );
  const normalizedTaxId = sql<string>`regexp_replace(${contacts.taxId}, '\\D', '', 'g')`;
  const existingTaxIds =
    candidateTaxIds.length === 0
      ? []
      : await tx
          .select({ id: contacts.id, taxId: normalizedTaxId })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              isNotNull(contacts.taxId),
              inArray(normalizedTaxId, candidateTaxIds),
            ),
          );
  const taxIdHolders = Map.groupBy(existingTaxIds, ({ taxId }) => taxId);
  // A stored tax id is a duplicate unless the only contact holding it is
  // the one this row updates.
  const isDuplicateTaxId = (
    { dedupeTaxId }: ValidatedImportRow,
    existingId: SafeId<"contact"> | null,
  ): boolean =>
    dedupeTaxId !== null &&
    taxIdHolders.get(dedupeTaxId)?.some(({ id }) => id !== existingId) === true;

  const countRow = (
    await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.organizationId, organizationId))
  ).at(0);
  const total = countRow?.total ?? panic("Contact count query returned no row");
  let remainingCapacity = Math.max(0, LIMITS.contactsCount - total);

  const skipReasonFor = (
    candidate: ValidatedImportRow,
  ): ImportSkipReason | null => {
    const existingId =
      candidate.external === null
        ? null
        : (existingIdByRef.get(externalRefKey(candidate.external)) ?? null);
    if (existingId !== null) {
      // An update re-imports a contact this organization already holds: it
      // takes no capacity, and the freshly minted id is moot.
      return isDuplicateTaxId(candidate, existingId)
        ? "duplicate_tax_id"
        : null;
    }
    if (existingIdSet.has(candidate.id)) {
      return "duplicate_contact_id";
    }
    if (isDuplicateTaxId(candidate, null)) {
      return "duplicate_tax_id";
    }
    if (remainingCapacity === 0) {
      return "contacts_limit_reached";
    }
    remainingCapacity -= 1;
    return null;
  };

  const rowsToWrite: PlannedImportRow[] = [];
  for (const candidate of validatedRows) {
    const reason = skipReasonFor(candidate);
    if (reason === null) {
      // An update writes under the stored contact's id, and the ref upsert
      // can only absorb a conflict on the ref itself.
      const existingId =
        candidate.external === null
          ? null
          : (existingIdByRef.get(externalRefKey(candidate.external)) ?? null);
      rowsToWrite.push(
        existingId === null
          ? { ...candidate, updatesStoredContact: false }
          : { ...candidate, id: existingId, updatesStoredContact: true },
      );
      continue;
    }
    resultByIndex.set(candidate.index, {
      index: candidate.index,
      status: "skipped",
      reason,
    });
  }
  return rowsToWrite;
};

type WriteImportRowsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  importRequestId: SafeId<"contactImportRequest">;
  recordAuditEvent: AuditRecorder;
  rowsToWrite: readonly PlannedImportRow[];
  taxIdScheme: ContactImportTaxIdScheme;
  resultByIndex: Map<number, ImportResultRow>;
};

/**
 * Insert new rows, with or without a ref; upsert rows whose ref an earlier
 * import wrote, so that contact is updated. New rows skip any id conflict
 * instead of aborting the batch, as rows without a ref always did.
 * Every field the import models takes the incoming value, so a re-run
 * mirrors the source; what it does not model
 * (attorneys, billing details, colour, monitoring) keeps its stella value,
 * and stored metadata keys the row does not carry survive the merge.
 */
const writeImportRows = async ({
  tx,
  organizationId,
  userId,
  importRequestId,
  recordAuditEvent,
  rowsToWrite,
  taxIdScheme,
  resultByIndex,
}: WriteImportRowsOptions): Promise<void> => {
  const importedAt = new Date();
  const toContactValues = ({ id, external, contact }: ValidatedImportRow) => ({
    id,
    organizationId,
    createdBy: userId,
    ...externalRefValues({
      external,
      externalChangeKey: fingerprintContactImport([
        taxIdScheme,
        { ...contact, metadata: normalizeContactMetadata(contact.metadata) },
      ]),
      importedAt,
    }),
    type: contact.type,
    displayName: contact.displayName,
    prefix: contact.prefix,
    firstName: contact.firstName,
    middleName: contact.middleName,
    lastName: contact.lastName,
    suffix: contact.suffix,
    organizationName:
      contact.organizationName ??
      (contact.type === "organization" ? contact.displayName : undefined),
    notes: contact.notes,
    emails: contact.emails,
    phones: contact.phones,
    addresses: contact.addresses,
    tags: contact.tags,
    registrationNumber: contact.registrationNumber,
    ...importedTaxIdentifiers(contact.taxId, taxIdScheme),
    ...(contact.dateOfBirth === undefined
      ? {}
      : dateOfBirthToColumns(contact.dateOfBirth)),
    nationalityCodes: contact.nationalityCodes,
    metadata: normalizeContactMetadata(contact.metadata),
  });
  const newRows = rowsToWrite.filter(
    ({ updatesStoredContact }) => !updatesStoredContact,
  );
  const updateRows = rowsToWrite.filter(
    ({ updatesStoredContact }) => updatesStoredContact,
  );
  const written = await writeImportedContacts({
    tx,
    recordAuditEvent,
    importRequestId,
    newRows: newRows.map(toContactValues),
    updateRows: updateRows.map(toContactValues),
    importedAt,
  });
  const writtenById = new Map(written.map((row) => [row.id, row]));
  for (const candidate of rowsToWrite) {
    const row = writtenById.get(candidate.id);
    resultByIndex.set(
      candidate.index,
      row === undefined
        ? {
            index: candidate.index,
            status: "skipped",
            reason: "duplicate_contact_id",
          }
        : { index: candidate.index, status: row.outcome, contactId: row.id },
    );
  }
};

type ImportContactRowsOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: ImportBody;
};

/**
 * One import batch in one transaction: replay or conflict on a known
 * importRequestId, otherwise validate, dedupe, write and record the receipt.
 * Search projection flushing stays with the caller, after commit.
 */
export const importContactRows = async ({
  safeDb,
  organizationId,
  userId,
  recordAuditEvent,
  body,
}: ImportContactRowsOptions) => {
  const requestFingerprint = fingerprintContactImport([
    body.taxIdScheme,
    ...body.rows,
  ]);

  return await safeDb(async (tx) => {
    await lockContactCapacity(tx, organizationId);

    const existingRequest = await tx.query.contactImportRequests.findFirst({
      where: {
        organizationId: { eq: organizationId },
        userId: { eq: userId },
        idempotencyKey: { eq: body.importRequestId },
      },
    });
    if (existingRequest) {
      if (existingRequest.requestFingerprint !== requestFingerprint) {
        return { status: "conflict" as const };
      }
      return {
        status: "replayed" as const,
        result: existingRequest.result,
      };
    }

    const resultByIndex = new Map<number, ImportResultRow>();
    const validatedRows = validateImportRows(body, resultByIndex);
    const rowsToWrite = await planImportWrites({
      tx,
      organizationId,
      validatedRows,
      resultByIndex,
    });
    await writeImportRows({
      tx,
      organizationId,
      userId,
      importRequestId: body.importRequestId,
      recordAuditEvent,
      rowsToWrite,
      taxIdScheme: body.taxIdScheme,
      resultByIndex,
    });

    const result = {
      results: body.rows.map(
        (_, index) =>
          resultByIndex.get(index) ??
          panic("Contact import result is incomplete"),
      ),
    } satisfies ContactImportReceiptResult;

    // audit: skip - idempotency receipt; writeImportRows audits every contact it wrote.
    await tx.insert(contactImportRequests).values({
      id: createSafeId<"contactImportRequest">(),
      organizationId,
      userId,
      idempotencyKey: body.importRequestId,
      requestFingerprint,
      result,
    });

    return { status: "created" as const, result };
  });
};
