import { panic } from "better-result";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { CONTACT_IMPORT_ISSUE_CODE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  type ContactImportReceiptResult,
  contactImportRequests,
  contacts,
  type ContactType,
} from "@/api/db/schema";
import { lockContactCapacity } from "@/api/handlers/contacts/contact-capacity";
import { validateContactImportCandidate } from "@/api/handlers/contacts/contact-import-file";
import type {
  ContactImportCandidate,
  ContactImportIssue,
} from "@/api/handlers/contacts/contact-import-file";
import { fingerprintContactImport } from "@/api/handlers/contacts/contact-import-receipt";
import {
  contactImportCandidateSchema,
  taxIdSchemeSchema,
} from "@/api/handlers/contacts/contact-import-schema";
import { normalizeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import { dateOfBirthToColumns } from "@/api/handlers/contacts/person-details";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  externalRefFromColumns,
  externalRefKey,
  tExternalRef,
} from "@/api/lib/imports/external-ref";
import type { ExternalRef } from "@/api/lib/imports/external-ref";
import {
  excluded,
  externalRefConflict,
  readExternalRefIds,
  upsertOutcome,
} from "@/api/lib/imports/upsert-by-external-id";
import { LIMITS } from "@/api/lib/limits";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";

// The reviewed row plus the caller-generated id and, optionally, the row's
// identity in the system it came from. The field set itself lives in
// `contact-import-schema.ts`, shared with the validate handler.
const importContactRowSchema = t.Composite([
  t.Object({ id: tSafeId("contact"), external: t.Optional(tExternalRef) }),
  contactImportCandidateSchema,
]);

export const importContactsBodySchema = t.Object({
  importRequestId: tSafeId("contactImportRequest"),
  taxIdScheme: taxIdSchemeSchema,
  rows: t.Array(importContactRowSchema, {
    maxItems: LIMITS.contactsImportRowsMax,
  }),
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
 * caller's id.
 */
type PlannedImportRow = ValidatedImportRow & { updatesStoredContact: boolean };

type ImportBody = Static<typeof importContactsBodySchema>;

const TAX_ID_ISSUE_CODES: ReadonlySet<ContactImportIssue["code"]> = new Set([
  CONTACT_IMPORT_ISSUE_CODE.INVALID_TAX_ID,
  CONTACT_IMPORT_ISSUE_CODE.TAX_ID_REQUIRED,
]);

// A row the validator rejects is skipped, never partially stored; tax-id
// problems keep their own reason so the receipt says which rule failed.
const skipReasonForIssues = (
  issues: readonly ContactImportIssue[],
): Extract<ImportSkipReason, "invalid_row" | "invalid_tax_id"> =>
  issues.some(({ code }) => TAX_ID_ISSUE_CODES.has(code))
    ? "invalid_tax_id"
    : "invalid_row";

type ImportRowRuling =
  | { type: "accept"; row: ValidatedImportRow }
  | { type: "skip"; reason: ImportSkipReason };

/**
 * Validate each row and drop in-batch repeats of a contact id, external ref
 * or (under `br_cpf_cnpj`) tax id; the first occurrence wins.
 */
const validateImportRows = (
  body: ImportBody,
  resultByIndex: Map<number, ImportResultRow>,
): ValidatedImportRow[] => {
  const seenContactIds = new Set<SafeId<"contact">>();
  const seenExternalRefs = new Set<string>();
  const seenTaxIds = new Set<string>();

  const rule = (
    index: number,
    { id, external, ...candidate }: ImportBody["rows"][number],
  ): ImportRowRuling => {
    const { contact, issues } = validateContactImportCandidate({
      candidate,
      taxIdScheme: body.taxIdScheme,
      rowNumber: index + 1,
    });
    if (issues.length > 0) {
      return { type: "skip", reason: skipReasonForIssues(issues) };
    }
    if (seenContactIds.has(id)) {
      return { type: "skip", reason: "duplicate_contact_id" };
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
    seenContactIds.add(id);
    if (externalKey !== null) {
      seenExternalRefs.add(externalKey);
    }
    if (dedupeTaxId !== null) {
      seenTaxIds.add(dedupeTaxId);
    }
    return {
      type: "accept",
      row: { index, id, external: external ?? null, contact, dedupeTaxId },
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
          .where(inArray(contacts.id, candidateIds));
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
      // takes no capacity, and the caller's fresh id is moot.
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
      // An update writes under the stored contact's id: the caller's id
      // might belong to another contact, and the ref upsert can only absorb
      // a conflict on the ref itself.
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

const importAuditEvents = ({
  written,
  action,
  importRequestId,
}: {
  written: readonly WrittenContact[];
  action: typeof AUDIT_ACTION.CREATE | typeof AUDIT_ACTION.UPDATE;
  importRequestId: SafeId<"contactImportRequest">;
}): AuditEvent[] =>
  written.map((contact) => ({
    action,
    resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
    resourceId: contact.id,
    workspaceId: null,
    changes: {
      [action === AUDIT_ACTION.CREATE ? "created" : "imported"]: {
        old: null,
        new: { type: contact.type, displayName: contact.displayName },
      },
    },
    metadata: { source: "import", importRequestId },
  }));

type WriteImportRowsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  importRequestId: SafeId<"contactImportRequest">;
  recordAuditEvent: AuditRecorder;
  rowsToWrite: readonly PlannedImportRow[];
  resultByIndex: Map<number, ImportResultRow>;
};

type WrittenContact = {
  id: SafeId<"contact">;
  type: ContactType;
  displayName: string;
};

/**
 * Insert new rows, with or without a ref; upsert rows whose ref an earlier
 * import wrote, so that contact is updated. A new row's caller id may already
 * belong to a contact this organization cannot see, so new rows skip any
 * conflict instead of aborting the batch, as rows without a ref always did.
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
  resultByIndex,
}: WriteImportRowsOptions): Promise<void> => {
  const importedAt = new Date();
  const toContactValues = ({ id, external, contact }: ValidatedImportRow) => ({
    id,
    organizationId,
    createdBy: userId,
    externalSource: external?.source,
    externalId: external?.id,
    importedAt: external === null ? undefined : importedAt,
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
    taxId: contact.taxId,
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
  const written = {
    id: contacts.id,
    type: contacts.type,
    displayName: contacts.displayName,
  };

  const inserted =
    newRows.length === 0
      ? []
      : await tx
          .insert(contacts)
          .values(newRows.map(toContactValues))
          .onConflictDoNothing()
          .returning(written);
  const conflict = externalRefConflict(contacts);
  const upserted =
    updateRows.length === 0
      ? []
      : await tx
          .insert(contacts)
          .values(updateRows.map(toContactValues))
          .onConflictDoUpdate({
            target: conflict.target,
            targetWhere: conflict.targetWhere,
            set: {
              importedAt: excluded(contacts.importedAt),
              type: excluded(contacts.type),
              displayName: excluded(contacts.displayName),
              prefix: excluded(contacts.prefix),
              firstName: excluded(contacts.firstName),
              middleName: excluded(contacts.middleName),
              lastName: excluded(contacts.lastName),
              suffix: excluded(contacts.suffix),
              organizationName: excluded(contacts.organizationName),
              notes: excluded(contacts.notes),
              emails: excluded(contacts.emails),
              phones: excluded(contacts.phones),
              addresses: excluded(contacts.addresses),
              tags: excluded(contacts.tags),
              registrationNumber: excluded(contacts.registrationNumber),
              taxId: excluded(contacts.taxId),
              dateOfBirthYear: excluded(contacts.dateOfBirthYear),
              dateOfBirthMonth: excluded(contacts.dateOfBirthMonth),
              dateOfBirthDay: excluded(contacts.dateOfBirthDay),
              nationalityCodes: excluded(contacts.nationalityCodes),
              metadata: sql`COALESCE(${contacts.metadata}, '{}'::jsonb) || COALESCE(${excluded(contacts.metadata)}, '{}'::jsonb)`,
              updatedAt: importedAt,
            },
          })
          .returning({
            ...written,
            externalSource: contacts.externalSource,
            externalId: contacts.externalId,
            outcome: upsertOutcome,
          });

  const insertedIds = new Set(inserted.map(({ id }) => id));
  const upsertedByRef = new Map(
    upserted.map((row) => [
      externalRefKey(
        externalRefFromColumns(row) ??
          panic("An external-ref upsert returned a row without its ref"),
      ),
      row,
    ]),
  );
  for (const candidate of rowsToWrite) {
    if (!candidate.updatesStoredContact) {
      resultByIndex.set(
        candidate.index,
        insertedIds.has(candidate.id)
          ? {
              index: candidate.index,
              status: "created",
              contactId: candidate.id,
            }
          : {
              index: candidate.index,
              status: "skipped",
              reason: "duplicate_contact_id",
            },
      );
      continue;
    }
    const row =
      upsertedByRef.get(
        externalRefKey(
          candidate.external ??
            panic("A stored-contact update carries no external ref"),
        ),
      ) ?? panic("An external-ref upsert dropped a row");
    resultByIndex.set(candidate.index, {
      index: candidate.index,
      status: row.outcome,
      contactId: row.id,
    });
  }

  const created = [
    ...inserted,
    ...upserted.filter(({ outcome }) => outcome === "created"),
  ];
  const updated = upserted.filter(({ outcome }) => outcome === "updated");
  const auditEvents = [
    ...importAuditEvents({
      written: created,
      action: AUDIT_ACTION.CREATE,
      importRequestId,
    }),
    ...importAuditEvents({
      written: updated,
      action: AUDIT_ACTION.UPDATE,
      importRequestId,
    }),
  ];
  if (auditEvents.length > 0) {
    await recordAuditEvent(tx, auditEvents);
    await enqueueContactSearchRepairs(
      tx,
      [...created, ...updated].map(({ id }) => id),
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
