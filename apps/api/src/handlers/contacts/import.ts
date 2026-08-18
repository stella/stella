import { Result, panic } from "better-result";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";

import { CONTACT_IMPORT_ISSUE_CODE } from "@stll/api-contract";

import {
  contactImportRequests,
  contacts,
  type ContactImportReceiptResult,
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
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditEvent } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  enqueueContactSearchRepairs,
  flushContactSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";

// The reviewed row plus the caller-generated id. The field set itself lives in
// `contact-import-schema.ts`, shared with the validate handler.
const importContactRowSchema = t.Composite([
  t.Object({ id: tSafeId("contact") }),
  contactImportCandidateSchema,
]);

const importContactsBodySchema = t.Object({
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
  contact: ContactImportCandidate;
  /** Normalized digits under `br_cpf_cnpj`; null when no scheme dedupes. */
  dedupeTaxId: string | null;
};

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

const config = {
  description:
    "Import a reviewed batch of up to 500 contacts into the organization " +
    "address book. Supply a caller-generated importRequestId: replaying it " +
    "with the same rows returns the original result, while changing the rows " +
    "is rejected. taxIdScheme selects tax-id validation (none, or " +
    "br_cpf_cnpj checksums with duplicate detection). Rows failing the " +
    "import rules, duplicates, and over-limit rows are skipped; all " +
    "accepted rows commit atomically.",
  permissions: { contact: ["create"] },
  mcp: { type: "covered", by: "save_contact" },
  body: importContactsBodySchema,
} satisfies HandlerConfig;

const importContacts = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const requestFingerprint = fingerprintContactImport([
      body.taxIdScheme,
      ...body.rows,
    ]);

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockContactCapacity(tx, organizationId);

        const existingRequest = await tx.query.contactImportRequests.findFirst({
          where: {
            organizationId: { eq: organizationId },
            userId: { eq: user.id },
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

        const validatedRows: ValidatedImportRow[] = [];
        const resultByIndex = new Map<number, ImportResultRow>();
        const seenContactIds = new Set<SafeId<"contact">>();
        const seenTaxIds = new Set<string>();

        for (const [index, { id, ...candidate }] of body.rows.entries()) {
          const { contact, issues } = validateContactImportCandidate({
            candidate,
            taxIdScheme: body.taxIdScheme,
            rowNumber: index + 1,
          });
          if (issues.length > 0) {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: skipReasonForIssues(issues),
            });
            continue;
          }
          if (seenContactIds.has(id)) {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: "duplicate_contact_id",
            });
            continue;
          }
          // Under `br_cpf_cnpj` the validator has normalized the tax id to
          // digits and guaranteed its presence, so it is the dedupe key.
          const dedupeTaxId =
            body.taxIdScheme === "br_cpf_cnpj" ? (contact.taxId ?? null) : null;
          if (dedupeTaxId !== null && seenTaxIds.has(dedupeTaxId)) {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: "duplicate_tax_id",
            });
            continue;
          }

          seenContactIds.add(id);
          if (dedupeTaxId !== null) {
            seenTaxIds.add(dedupeTaxId);
          }
          validatedRows.push({ index, id, contact, dedupeTaxId });
        }

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
                .select({ taxId: normalizedTaxId })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.organizationId, organizationId),
                    isNotNull(contacts.taxId),
                    inArray(normalizedTaxId, candidateTaxIds),
                  ),
                );
        const existingTaxIdSet = new Set(
          existingTaxIds.map(({ taxId }) => taxId),
        );

        const countRow = (
          await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(contacts)
            .where(eq(contacts.organizationId, organizationId))
        ).at(0);
        const total =
          countRow?.total ?? panic("Contact count query returned no row");
        let remainingCapacity = Math.max(0, LIMITS.contactsCount - total);

        const rowsToInsert: ValidatedImportRow[] = [];
        for (const candidate of validatedRows) {
          if (existingIdSet.has(candidate.id)) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "duplicate_contact_id",
            });
            continue;
          }
          if (
            candidate.dedupeTaxId !== null &&
            existingTaxIdSet.has(candidate.dedupeTaxId)
          ) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "duplicate_tax_id",
            });
            continue;
          }
          if (remainingCapacity === 0) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "contacts_limit_reached",
            });
            continue;
          }

          rowsToInsert.push(candidate);
          remainingCapacity -= 1;
        }

        const created =
          rowsToInsert.length === 0
            ? []
            : await tx
                .insert(contacts)
                .values(
                  rowsToInsert.map(({ id, contact }) => ({
                    id,
                    organizationId,
                    createdBy: user.id,
                    type: contact.type,
                    displayName: contact.displayName,
                    prefix: contact.prefix,
                    firstName: contact.firstName,
                    middleName: contact.middleName,
                    lastName: contact.lastName,
                    suffix: contact.suffix,
                    organizationName:
                      contact.organizationName ??
                      (contact.type === "organization"
                        ? contact.displayName
                        : undefined),
                    notes: contact.notes,
                    emails: contact.emails,
                    phones: contact.phones,
                    addresses: contact.addresses,
                    tags: contact.tags,
                    registrationNumber: contact.registrationNumber,
                    taxId: contact.taxId,
                    metadata: normalizeContactMetadata(contact.metadata),
                  })),
                )
                .onConflictDoNothing()
                .returning();
        const createdById = new Map(created.map((row) => [row.id, row]));

        for (const candidate of rowsToInsert) {
          const createdRow = createdById.get(candidate.id);
          resultByIndex.set(
            candidate.index,
            createdRow
              ? {
                  index: candidate.index,
                  status: "created",
                  contactId: createdRow.id,
                }
              : {
                  index: candidate.index,
                  status: "skipped",
                  reason: "duplicate_contact_id",
                },
          );
        }

        if (created.length > 0) {
          const auditEvents = created.map((contact): AuditEvent => ({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
            resourceId: contact.id,
            workspaceId: null,
            changes: {
              created: {
                old: null,
                new: {
                  type: contact.type,
                  displayName: contact.displayName,
                },
              },
            },
            metadata: {
              source: "import",
              importRequestId: body.importRequestId,
            },
          }));
          await recordAuditEvent(tx, auditEvents);
          await enqueueContactSearchRepairs(
            tx,
            created.map(({ id }) => id),
          );
        }

        const result = {
          results: body.rows.map((_, index) => {
            const rowResult = resultByIndex.get(index);
            if (!rowResult) {
              panic("Contact import result is incomplete");
            }
            return rowResult;
          }),
        } satisfies ContactImportReceiptResult;

        await tx.insert(contactImportRequests).values({
          id: createSafeId<"contactImportRequest">(),
          organizationId,
          userId: user.id,
          idempotencyKey: body.importRequestId,
          requestFingerprint,
          result,
        });

        return { status: "created" as const, result };
      }),
    );

    if (outcome.status === "conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Import request was already used for different contacts",
        }),
      );
    }

    const createdContactIds = outcome.result.results.flatMap((result) =>
      result.status === "created" ? [result.contactId] : [],
    );
    if (createdContactIds.length > 0) {
      flushContactSearchRepairs(createdContactIds).catch(captureError);
    }

    return Result.ok({
      ...outcome.result,
      replayed: outcome.status === "replayed",
    });
  },
);

export default importContacts;
