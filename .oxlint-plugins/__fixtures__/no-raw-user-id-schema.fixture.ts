// Passive regression fixture for `no-raw-user-id-schema/no-raw-user-id-schema`.

declare const t: { String: () => unknown };
declare const tUserId: unknown;

// oxlint-disable-next-line no-raw-user-id-schema/no-raw-user-id-schema -- fixture proves user IDs cannot use an unbranded string schema
const rawUserSchema = { userId: t.String() };
// oxlint-disable-next-line no-raw-user-id-schema/no-raw-user-id-schema -- fixture proves contact owner IDs require organization-membership validation
const unvalidatedOwnerSchema = { responsibleAttorneyId: tUserId };

const brandedUserSchema = { userId: tUserId };
const unrelatedStringSchema = { search: t.String() };

export {
  brandedUserSchema,
  rawUserSchema,
  unrelatedStringSchema,
  unvalidatedOwnerSchema,
};
