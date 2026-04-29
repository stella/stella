import { Result } from "better-result";
import { count, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactMetadataSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { normalizeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const createContactBodySchema = t.Object({
  id: tSafeId("contact"),
  type: t.UnionEnum(["person", "organization"]),
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
  defaultHourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  paymentTermDays: t.Optional(t.Integer({ minimum: 0, maximum: 365 })),
  originatingAttorneyId: t.Optional(tUserId),
  responsibleAttorneyId: t.Optional(tUserId),
});

const createContact = createSafeRootHandler(
  {
    permissions: { contact: ["create"] },
    body: createContactBodySchema,
  },
  async function* ({ safeDb, session, user, body }) {
    const [totalRow] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ total: count() })
          .from(contacts)
          .where(eq(contacts.organizationId, session.activeOrganizationId)),
      ),
    );

    const total = totalRow?.total ?? 0;

    if (total >= LIMITS.contactsCount) {
      return Result.err(
        new HandlerError({ status: 400, message: "Contacts limit reached" }),
      );
    }

    const attorneyIds: SafeId<"user">[] = [];
    if (body.originatingAttorneyId) {
      attorneyIds.push(body.originatingAttorneyId);
    }
    if (body.responsibleAttorneyId) {
      attorneyIds.push(body.responsibleAttorneyId);
    }

    if (attorneyIds.length > 0) {
      const uniqueAttorneyIds = [...new Set(attorneyIds)];
      const validAttorneyIds = yield* Result.await(
        safeDb(async (tx) => {
          const results: (SafeId<"user"> | null)[] = [];
          for (const attorneyId of uniqueAttorneyIds) {
            results.push(
              await validateOrgUserId(
                tx,
                attorneyId,
                session.activeOrganizationId,
              ),
            );
          }
          return results;
        }),
      );

      if (validAttorneyIds.some((attorneyId) => attorneyId === null)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "User is not a member of this organization",
          }),
        );
      }
    }

    const [contact] = yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(contacts)
          .values({
            id: body.id,
            organizationId: session.activeOrganizationId,
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
            createdBy: user.id,
          })
          .returning(),
      ),
    );

    return Result.ok(contact);
  },
);

export default createContact;
