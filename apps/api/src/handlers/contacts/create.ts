import { count, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { createRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const createContactBodySchema = t.Object({
  id: tNanoid,
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
  tags: t.Optional(t.Array(t.String(), { maxItems: 50 })),
  color: t.Optional(t.String({ maxLength: 32 })),
  registrationNumber: t.Optional(t.String({ maxLength: 64 })),
  taxId: t.Optional(t.String({ maxLength: 64 })),
  bankAccounts: t.Optional(t.Array(bankAccountSchema, { maxItems: 10 })),
  billingAddress: t.Optional(billingAddressSchema),
  defaultHourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  paymentTermDays: t.Optional(t.Integer({ minimum: 0, maximum: 365 })),
  originatingAttorneyId: t.Optional(t.String()),
  responsibleAttorneyId: t.Optional(t.String()),
});

const createContact = createRootHandler(
  {
    permissions: { contact: ["create"] },
    body: createContactBodySchema,
  },
  async ({ scopedDb, session, user, body }) => {
    const [totalRow] = await scopedDb((tx) =>
      tx
        .select({ total: count() })
        .from(contacts)
        .where(eq(contacts.organizationId, session.activeOrganizationId)),
    );

    const total = totalRow?.total ?? 0;

    if (total >= LIMITS.contactsCount) {
      return status(400, { message: "Contacts limit reached" });
    }

    const [contact] = await scopedDb((tx) =>
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
          tags: body.tags,
          color: body.color,
          registrationNumber: body.registrationNumber,
          taxId: body.taxId,
          bankAccounts: body.bankAccounts,
          billingAddress: body.billingAddress,
          defaultHourlyRate: body.defaultHourlyRate,
          currency: body.currency,
          paymentTermDays: body.paymentTermDays,
          originatingAttorneyId: body.originatingAttorneyId,
          responsibleAttorneyId: body.responsibleAttorneyId,
          createdBy: user.id,
        })
        .returning(),
    );

    return contact;
  },
);

export default createContact;
