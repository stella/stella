// Passive regression fixture for `no-raw-user-id-schema/no-raw-user-id-schema`.

import * as v from "valibot";

declare const userIdSchema: v.GenericSchema<string>;

// oxlint-disable-next-line no-raw-user-id-schema/no-raw-user-id-schema -- fixture proves user IDs cannot use an inline string schema
const rawUserSchema = v.object({ userId: v.string() });
const rawLeadSchema = v.object({
  // oxlint-disable-next-line no-raw-user-id-schema/no-raw-user-id-schema -- fixture proves a bounded inline string is still not the shared user ID schema
  leadUserId: v.optional(v.pipe(v.string(), v.maxLength(128))),
});
const unvalidatedOwnerSchema = v.object({
  // oxlint-disable-next-line no-raw-user-id-schema/no-raw-user-id-schema -- fixture proves contact owner IDs require organization-membership validation
  responsibleAttorneyId: userIdSchema,
});

// expect-clean: no-raw-user-id-schema/no-raw-user-id-schema
const brandedUserSchema = v.object({ userId: userIdSchema });
const optionalUserSchema = v.object({ toUserId: v.nullable(userIdSchema) });
const unrelatedStringSchema = v.object({ search: v.string() });

export {
  brandedUserSchema,
  optionalUserSchema,
  rawLeadSchema,
  rawUserSchema,
  unrelatedStringSchema,
  unvalidatedOwnerSchema,
};
