import { Result, panic } from "better-result";
import { count, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

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
import { createContactTypeSchema } from "@/api/handlers/contacts/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tMinorUnitAmount, tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  enqueueContactSearchRepairs,
  flushContactSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

export const createContactBodySchema = t.Object({
  id: tSafeId("contact"),
  type: createContactTypeSchema,
  prefix: t.Optional(t.String({ maxLength: 32 })),
  firstName: t.Optional(t.String({ maxLength: 256 })),
  middleName: t.Optional(t.String({ maxLength: 256 })),
  lastName: t.Optional(t.String({ maxLength: 256 })),
  suffix: t.Optional(t.String({ maxLength: 32 })),
  organizationName: t.Optional(t.String({ maxLength: 512 })),
  displayName: t.String({ minLength: 1, maxLength: 512 }),
  notes: t.Optional(t.String()),
  emails: t.Optional(t.Array(contactEmailSchema, { maxItems: 20 })),
  phones: t.Optional(t.Array(contactPhoneSchema, { maxItems: 20 })),
  addresses: t.Optional(t.Array(contactAddressSchema, { maxItems: 10 })),
  metadata: t.Optional(contactMetadataSchema),
  tags: t.Optional(t.Array(t.String(), { maxItems: 50 })),
  color: t.Optional(t.String({ maxLength: 32 })),
  registrationNumber: t.Optional(t.String({ maxLength: 64 })),
  taxId: t.Optional(t.String({ maxLength: 64 })),
  bankAccounts: t.Optional(t.Array(bankAccountSchema, { maxItems: 10 })),
  billingAddress: t.Optional(billingAddressSchema),
  defaultHourlyRate: t.Optional(tMinorUnitAmount(0)),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  paymentTermDays: t.Optional(t.Integer({ minimum: 0, maximum: 365 })),
  originatingAttorneyId: t.Optional(tUserId),
  responsibleAttorneyId: t.Optional(tUserId),
});

export type CreateContactBody = Static<typeof createContactBodySchema>;

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
      taxId: body.taxId,
      bankAccounts: body.bankAccounts,
      billingAddress: body.billingAddress,
      defaultHourlyRate:
        body.defaultHourlyRate === undefined
          ? body.defaultHourlyRate
          : cents(body.defaultHourlyRate),
      currency: body.currency,
      paymentTermDays: body.paymentTermDays,
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

      if (attorneyIds.length > 0) {
        const uniqueAttorneyIds = [...new Set(attorneyIds)];
        for (const attorneyId of uniqueAttorneyIds) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded: at most two attorney ids per request, deduplicated
          const validAttorneyId = await validateOrgUserId(
            tx,
            brandPersistedUserId(attorneyId),
            organizationId,
          );
          if (!validAttorneyId) {
            return { kind: "invalid_attorney" };
          }
        }
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

  flushContactSearchRepairs([created.id]).catch(captureError);

  return Result.ok(created);
};

const createContact = createSafeRootHandler(
  {
    description:
      "Create a contact in the organization address book. type (person or " +
      "organization), displayName, and the contact id are supplied in the " +
      "body; names, emails, phones, addresses, tags, registration and tax " +
      "numbers, bank and billing details, default hourly rate, payment " +
      "terms, and originating or responsible attorneys are optional. Refused " +
      "once the organization holds its maximum number of contacts, or when " +
      "an attorney id is not a member of the organization.",
    permissions: { contact: ["create"] },
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
