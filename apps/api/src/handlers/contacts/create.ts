import { panic, Result } from "better-result";
import { count, eq } from "drizzle-orm";
import * as v from "valibot";

import { PARTY_IDENTIFIER_MAX_LENGTH } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactMetadataSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { lockContactCapacity } from "@/api/handlers/contacts/contact-capacity";
import { normalizeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import {
  dateOfBirthToColumns,
  validatePersonDetails,
} from "@/api/handlers/contacts/person-details";
import { createContactTypeSchema } from "@/api/handlers/contacts/schema";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { contactTaxIdentifiers } from "@/api/lib/billing/invoice-prefill.logic";
import type { SafeId } from "@/api/lib/branded-types";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import { nationalityCodesSchema } from "@/api/lib/business-registries/nationality-codes";
import {
  invoiceLanguageSchema,
  minorUnitAmountSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushContactSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { lockOrgUserIdsForAssignment } from "@/api/lib/validated-org-user-id";

export const createContactBodySchema = v.object({
  id: resourceIdSchema("contact"),
  type: createContactTypeSchema,
  prefix: v.optional(v.pipe(v.string(), v.maxLength(32))),
  firstName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  middleName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  lastName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  suffix: v.optional(v.pipe(v.string(), v.maxLength(32))),
  dateOfBirth: v.optional(dateOfBirthSchema),
  nationalityCodes: v.optional(nationalityCodesSchema),
  organizationName: v.optional(v.pipe(v.string(), v.maxLength(512))),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  notes: v.optional(v.string()),
  emails: v.optional(v.pipe(v.array(contactEmailSchema), v.maxLength(20))),
  phones: v.optional(v.pipe(v.array(contactPhoneSchema), v.maxLength(20))),
  addresses: v.optional(v.pipe(v.array(contactAddressSchema), v.maxLength(10))),
  metadata: v.optional(contactMetadataSchema),
  tags: v.optional(v.pipe(v.array(v.string()), v.maxLength(50))),
  color: v.optional(v.pipe(v.string(), v.maxLength(32))),
  registrationNumber: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  taxId: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  vatId: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  vatPayer: v.optional(v.nullable(v.boolean())),
  bankAccounts: v.optional(v.pipe(v.array(bankAccountSchema), v.maxLength(10))),
  billingAddress: v.optional(billingAddressSchema),
  defaultHourlyRate: v.optional(minorUnitAmountSchema(0)),
  currency: v.optional(v.pipe(v.string(), v.minLength(3), v.maxLength(3))),
  paymentTermDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(365)),
  ),
  invoiceLanguage: v.optional(v.nullable(invoiceLanguageSchema)),
  originatingAttorneyId: v.optional(userIdSchema),
  responsibleAttorneyId: v.optional(userIdSchema),
});

export type CreateContactBody = v.InferOutput<typeof createContactBodySchema>;

export type CreateContactHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: CreateContactBody;
};

/**
 * Count existing org contacts and report whether `additionalCount` more
 * would exceed `LIMITS.contactsCount`. Shared by the single-create handler
 * (additionalCount: 1) and the bulk-import handler (additionalCount: batch
 * size), which also uses the returned `total` to compute remaining capacity.
 */
export const checkContactsCountLimit = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  additionalCount: number,
): Promise<{ total: number; wouldExceed: boolean }> => {
  const [totalRow] = await tx
    .select({ total: count() })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId));

  const total = totalRow?.total ?? 0;

  return { total, wouldExceed: total + additionalCount > LIMITS.contactsCount };
};

export type InsertContactRowProps = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: CreateContactBody;
};

/**
 * Tx-scoped insert + audit event, reused by the single-create handler and
 * the bulk-import handler so both write identical rows/audit shapes inside
 * whichever transaction the caller already has open.
 */
export const insertContactRow = async ({
  tx,
  organizationId,
  userId,
  recordAuditEvent,
  body,
}: InsertContactRowProps) => {
  const [row] = await tx
    .insert(contacts)
    .values({
      id: body.id,
      organizationId,
      type: body.type,
      prefix: body.prefix,
      firstName: body.firstName,
      middleName: body.middleName,
      lastName: body.lastName,
      suffix: body.suffix,
      ...(body.dateOfBirth === undefined
        ? {}
        : dateOfBirthToColumns(body.dateOfBirth)),
      nationalityCodes: body.nationalityCodes,
      organizationName: body.organizationName,
      displayName: body.displayName,
      notes: body.notes,
      emails: body.emails,
      phones: body.phones,
      addresses: body.addresses,
      metadata: normalizeContactMetadata(body.metadata),
      tags: body.tags,
      color: body.color,
      registrationNumber: body.registrationNumber,
      ...contactTaxIdentifiers({
        taxId: body.taxId ?? null,
        vatId: body.vatId ?? null,
      }),
      vatPayer: body.vatPayer,
      bankAccounts: body.bankAccounts,
      billingAddress: body.billingAddress,
      defaultHourlyRate:
        body.defaultHourlyRate === undefined
          ? body.defaultHourlyRate
          : cents(body.defaultHourlyRate),
      currency: body.currency,
      paymentTermDays: body.paymentTermDays,
      invoiceLanguage: body.invoiceLanguage,
      originatingAttorneyId: body.originatingAttorneyId,
      responsibleAttorneyId: body.responsibleAttorneyId,
      createdBy: userId,
    })
    .returning();

  if (row) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: row.id,
      workspaceId: null,
      changes: {
        created: {
          old: null,
          new: {
            type: row.type,
            displayName: row.displayName,
          },
        },
      },
    });
    await enqueueContactSearchRepairs(tx, [row.id]);
  }

  return row;
};

type CreateContactOutcome =
  | { kind: "limit_reached" }
  | { kind: "invalid_attorney" }
  | { kind: "created"; row: typeof contacts.$inferSelect | undefined };

// Shared contact-creation logic reused by the HTTP handler and the
// `save_contact` MCP tool, so both emit identical audit events and
// search-index writes.
export const createContactHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  recordAuditEvent,
  body,
}: CreateContactHandlerProps) {
  const personDetailsError = validatePersonDetails(body);
  if (personDetailsError) {
    return Result.err(personDetailsError);
  }
  const outcome = yield* Result.await(
    safeDb(async (tx): Promise<CreateContactOutcome> => {
      await lockContactCapacity(tx, organizationId);

      const { wouldExceed } = await checkContactsCountLimit(
        tx,
        organizationId,
        1,
      );
      if (wouldExceed) {
        return { kind: "limit_reached" };
      }

      const attorneyIds: string[] = [];
      if (body.originatingAttorneyId) {
        attorneyIds.push(body.originatingAttorneyId);
      }
      if (body.responsibleAttorneyId) {
        attorneyIds.push(body.responsibleAttorneyId);
      }

      const validAttorneyIds = await lockOrgUserIdsForAssignment({
        tx,
        userIds: attorneyIds.map(brandPersistedUserId),
        organizationId,
      });
      if (!validAttorneyIds) {
        return { kind: "invalid_attorney" };
      }

      const row = await insertContactRow({
        tx,
        organizationId,
        userId,
        recordAuditEvent,
        body,
      });

      return { kind: "created", row };
    }),
  );

  if (outcome.kind === "limit_reached") {
    return Result.err(
      new HandlerError({ status: 400, message: "Contacts limit reached" }),
    );
  }

  if (outcome.kind === "invalid_attorney") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "User is not a member of this organization",
      }),
    );
  }

  const created = outcome.row ?? panic("Contact insert returned no row");

  flushContactSearchRepairs([created.id]).catch(
    createErrorCapture(
      handlerErrorContext("createContactHandler.flushContactSearchRepairs"),
    ),
  );

  return Result.ok(created);
};

const createContact = createSafeRootHandler(
  {
    contract: "patch",
    idempotency: { type: "replay" },
    description:
      "Create a contact in the organization address book. type (person or " +
      "organization), displayName, and the contact id are supplied in the " +
      "body; names, emails, phones, addresses, tags, registration and tax " +
      "numbers, bank and billing details, default hourly rate, payment " +
      "terms, and originating or responsible attorneys are optional. Refused " +
      "once the organization holds its maximum number of contacts, or when " +
      "an attorney id is not a member of the organization.",
    permissions: { contact: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "save_contact" },
    body: createContactBodySchema,
  },
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createContactHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default createContact;
