import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { PARTY_IDENTIFIER_MAX_LENGTH } from "@stll/api-contract";
import { currencyMinorUnitDigits } from "@stll/money";

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
import { mergeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import {
  dateOfBirthFromColumns,
  dateOfBirthToColumns,
  validatePersonDetails,
} from "@/api/handlers/contacts/person-details";
import { contactTypeSchema } from "@/api/handlers/contacts/schema";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { patchContactTaxIdentifiers } from "@/api/lib/billing/invoice-prefill.logic";
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
import { cents } from "@/api/lib/money";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushContactSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { lockOrgUserIdsForAssignment } from "@/api/lib/validated-org-user-id";

const updateContactBodySchema = v.object({
  type: v.optional(contactTypeSchema),
  prefix: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  firstName: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
  middleName: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
  lastName: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
  suffix: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  dateOfBirth: v.optional(v.nullable(dateOfBirthSchema)),
  nationalityCodes: v.optional(v.nullable(nationalityCodesSchema)),
  organizationName: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(512))),
  ),
  displayName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
  notes: v.optional(v.nullable(v.string())),
  emails: v.optional(
    v.nullable(v.pipe(v.array(contactEmailSchema), v.maxLength(20))),
  ),
  phones: v.optional(
    v.nullable(v.pipe(v.array(contactPhoneSchema), v.maxLength(20))),
  ),
  addresses: v.optional(
    v.nullable(v.pipe(v.array(contactAddressSchema), v.maxLength(10))),
  ),
  metadata: v.optional(v.nullable(contactMetadataSchema)),
  tags: v.optional(v.nullable(v.pipe(v.array(v.string()), v.maxLength(50)))),
  color: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  registrationNumber: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH))),
  ),
  taxId: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH))),
  ),
  vatId: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH))),
  ),
  vatPayer: v.optional(v.nullable(v.boolean())),
  bankAccounts: v.optional(
    v.nullable(v.pipe(v.array(bankAccountSchema), v.maxLength(10))),
  ),
  billingAddress: v.optional(v.nullable(billingAddressSchema)),
  defaultHourlyRate: v.optional(v.nullable(minorUnitAmountSchema(0))),
  currency: v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(3), v.maxLength(3))),
  ),
  paymentTermDays: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(365))),
  ),
  invoiceLanguage: v.optional(v.nullable(invoiceLanguageSchema)),
  originatingAttorneyId: v.optional(v.nullable(userIdSchema)),
  responsibleAttorneyId: v.optional(v.nullable(userIdSchema)),
});

const updateContactParamsSchema = v.object({
  contactId: resourceIdSchema("contact"),
});

export type UpdateContactHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
  recordAuditEvent: AuditRecorder;
  body: v.InferOutput<typeof updateContactBodySchema>;
};

type ContactRateUpdatesOptions = {
  tx: Transaction;
  contactId: SafeId<"contact">;
  organizationId: SafeId<"organization">;
  sourceCurrency: string | null;
  storedRate: number | null;
  currency: string | null | undefined;
  defaultHourlyRate: number | null | undefined;
};

const contactRateUpdates = async ({
  tx,
  contactId,
  organizationId,
  sourceCurrency,
  storedRate,
  currency,
  defaultHourlyRate,
}: ContactRateUpdatesOptions) => {
  if (defaultHourlyRate !== undefined) {
    return Result.ok({
      defaultHourlyRate:
        defaultHourlyRate === null ? null : cents(defaultHourlyRate),
    });
  }
  const exponentShift =
    storedRate !== null &&
    sourceCurrency &&
    currency &&
    currency !== sourceCurrency
      ? currencyMinorUnitDigits(currency) -
        currencyMinorUnitDigits(sourceCurrency)
      : 0;

  // Numeric arithmetic preserves integer precision before the API's safe
  // number boundary; refuse the entire update before any field is written.
  if (exponentShift > 0) {
    const beyondRange = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
          sql`ABS(ROUND(${contacts.defaultHourlyRate} * power(10::numeric, ${exponentShift}))) > ${Number.MAX_SAFE_INTEGER}`,
        ),
      )
      .limit(1);
    if (beyondRange.length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Currency change would put the contact rate out of range",
        }),
      );
    }
  }

  if (exponentShift === 0) {
    return Result.ok({ defaultHourlyRate: undefined });
  }
  return Result.ok({
    defaultHourlyRate: sql`ROUND(${contacts.defaultHourlyRate} * power(10::numeric, ${exponentShift}))::bigint`,
  });
};

/** Lock the contact row and read what the update validates against. */
const lockExistingContact = async ({
  tx,
  contactId,
  organizationId,
}: {
  tx: Transaction;
  contactId: UpdateContactHandlerProps["contactId"];
  organizationId: UpdateContactHandlerProps["organizationId"];
}) => {
  const rows = await tx
    .select({
      id: contacts.id,
      type: contacts.type,
      metadata: contacts.metadata,
      currency: contacts.currency,
      defaultHourlyRate: contacts.defaultHourlyRate,
      dateOfBirthYear: contacts.dateOfBirthYear,
      dateOfBirthMonth: contacts.dateOfBirthMonth,
      dateOfBirthDay: contacts.dateOfBirthDay,
      nationalityCodes: contacts.nationalityCodes,
      taxId: contacts.taxId,
      vatId: contacts.vatId,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.organizationId, organizationId),
      ),
    )
    .limit(1)
    .for("update");
  return rows.at(0);
};

// Shared contact-update logic reused by the HTTP handler and the
// `save_contact` MCP tool, so both emit identical audit events and
// search-index writes.
const CONTACT_REPAIR_KEY = "updateContactHandler.flushContactSearchRepairs";

export const updateContactHandler = async function* ({
  safeDb,
  organizationId,
  contactId,
  recordAuditEvent,
  body,
}: UpdateContactHandlerProps) {
  const attorneyIds = [body.originatingAttorneyId, body.responsibleAttorneyId]
    .filter((id) => id !== undefined && id !== null)
    .filter((id) => id.length > 0);

  const {
    defaultHourlyRate,
    metadata,
    dateOfBirth,
    nationalityCodes,
    ...rest
  } = body;

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const validAttorneyIds = await lockOrgUserIdsForAssignment({
        tx,
        userIds: attorneyIds.map(brandPersistedUserId),
        organizationId,
      });
      if (!validAttorneyIds) {
        return {
          kind: "invalid" as const,
          error: new HandlerError({
            status: 400,
            message: "User is not a member of this organization",
          }),
        };
      }
      const existing = await lockExistingContact({
        tx,
        contactId,
        organizationId,
      });
      if (!existing) {
        return { kind: "not_found" as const };
      }

      const error = validatePersonDetails({
        type: body.type ?? existing.type,
        dateOfBirth:
          dateOfBirth === undefined
            ? dateOfBirthFromColumns(existing)
            : dateOfBirth,
        nationalityCodes:
          nationalityCodes === undefined
            ? existing.nationalityCodes
            : nationalityCodes,
      });
      if (error) {
        return { kind: "invalid" as const, error };
      }

      const rateUpdates = await contactRateUpdates({
        tx,
        contactId,
        organizationId,
        sourceCurrency: existing.currency,
        storedRate: existing.defaultHourlyRate,
        currency: body.currency,
        defaultHourlyRate,
      });
      if (rateUpdates.isErr()) {
        return { kind: "invalid" as const, error: rateUpdates.error };
      }

      const updates = {
        ...pickDefined(rest, [
          "type",
          "prefix",
          "firstName",
          "middleName",
          "lastName",
          "suffix",
          "organizationName",
          "displayName",
          "notes",
          "emails",
          "phones",
          "addresses",
          "color",
          "tags",
          "registrationNumber",
          "vatPayer",
          "bankAccounts",
          "billingAddress",
          "currency",
          "paymentTermDays",
          "invoiceLanguage",
          "originatingAttorneyId",
          "responsibleAttorneyId",
        ]),
        ...(metadata === undefined
          ? {}
          : { metadata: mergeContactMetadata(existing.metadata, metadata) }),
        ...(dateOfBirth === undefined ? {} : dateOfBirthToColumns(dateOfBirth)),
        ...(nationalityCodes === undefined
          ? {}
          : {
              nationalityCodes: Array.isArray(nationalityCodes)
                ? nationalityCodes
                : [],
            }),
        ...pickDefined(rateUpdates.value, ["defaultHourlyRate"]),
        ...(rest.taxId === undefined && rest.vatId === undefined
          ? {}
          : patchContactTaxIdentifiers({
              stored: { taxId: existing.taxId, vatId: existing.vatId },
              taxId: rest.taxId,
              vatId: rest.vatId,
            })),
      };
      if (Object.keys(updates).length === 0) {
        return {
          kind: "updated" as const,
          row: { id: existing.id },
          changed: false,
        };
      }

      const rows = await tx
        .update(contacts)
        .set({
          type: updates.type,
          prefix: updates.prefix,
          firstName: updates.firstName,
          middleName: updates.middleName,
          lastName: updates.lastName,
          suffix: updates.suffix,
          organizationName: updates.organizationName,
          displayName: updates.displayName,
          notes: updates.notes,
          emails: updates.emails,
          phones: updates.phones,
          addresses: updates.addresses,
          color: updates.color,
          tags: updates.tags,
          registrationNumber: updates.registrationNumber,
          taxId: updates.taxId,
          vatId: updates.vatId,
          vatPayer: updates.vatPayer,
          bankAccounts: updates.bankAccounts,
          billingAddress: updates.billingAddress,
          currency: updates.currency,
          paymentTermDays: updates.paymentTermDays,
          invoiceLanguage: updates.invoiceLanguage,
          originatingAttorneyId: updates.originatingAttorneyId,
          responsibleAttorneyId: updates.responsibleAttorneyId,
          metadata: updates.metadata,
          dateOfBirthYear: updates.dateOfBirthYear,
          dateOfBirthMonth: updates.dateOfBirthMonth,
          dateOfBirthDay: updates.dateOfBirthDay,
          nationalityCodes: updates.nationalityCodes,
          defaultHourlyRate: updates.defaultHourlyRate,
        })
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.organizationId, organizationId),
          ),
        )
        .returning({ id: contacts.id });
      const row = rows.at(0);
      if (!row) {
        return { kind: "not_found" as const };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
        resourceId: contactId,
        workspaceId: null,
        changes: { fields: { old: null, new: Object.keys(updates) } },
      });
      await enqueueContactSearchRepairs(tx, [contactId]);
      return { kind: "updated" as const, row, changed: true };
    }),
  );

  if (outcome.kind === "not_found") {
    return Result.err(
      new HandlerError({ status: 404, message: "Contact not found" }),
    );
  }
  if (outcome.kind === "invalid") {
    return Result.err(outcome.error);
  }
  if (!outcome.changed) {
    return Result.ok(outcome.row);
  }

  flushContactSearchRepairs([contactId]).catch(
    createErrorCapture(handlerErrorContext(CONTACT_REPAIR_KEY)),
  );

  return Result.ok(outcome.row);
};

const updateContactById = createSafeRootHandler(
  {
    contract: "replace",
    precondition: {
      type: "deferred",
      baselineId: "apps/api/src/handlers/contacts/update.ts",
    },
    description:
      "Change a contact in the organization address book, writing only the " +
      "fields you pass and clearing a nullable one when you pass null. " +
      "metadata is merged into the stored object rather than replacing it. " +
      "An attorney id that is not a member of the organization is refused, " +
      "and an unknown contact is a 404.",
    permissions: { contact: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "save_contact" },
    params: updateContactParamsSchema,
    body: updateContactBodySchema,
  },
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateContactHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      contactId: params.contactId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateContactById;
