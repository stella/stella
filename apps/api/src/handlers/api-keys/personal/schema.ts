import { t } from "elysia";
import type { Static } from "elysia";

import { machineApiKeyNameSchema } from "@/api/handlers/api-keys/mint";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import {
  API_KEY_POLICY,
  PERSONAL_API_KEY_AUDIENCES,
  PERSONAL_API_KEY_SCOPES,
} from "@/api/lib/machine-api-key-config";

export const personalApiKeyExpirySchema = t.Optional(
  t.Integer({
    minimum: API_KEY_POLICY.personal.minDays,
    maximum: API_KEY_POLICY.personal.maxDays,
  }),
);
export const personalApiKeyBodySchema = t.Object({
  name: machineApiKeyNameSchema,
  scopes: t.Optional(
    t.Array(t.UnionEnum([...PERSONAL_API_KEY_SCOPES]), {
      minItems: 1,
      maxItems: PERSONAL_API_KEY_SCOPES.length,
      uniqueItems: true,
    }),
  ),
  audience: t.Optional(
    t.Union([
      t.Literal(PERSONAL_API_KEY_AUDIENCES[0]),
      t.Literal(PERSONAL_API_KEY_AUDIENCES[1]),
    ]),
  ),
  expiresInDays: personalApiKeyExpirySchema,
});
export const personalApiKeyIdBodySchema = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 128 }),
});
export const personalApiKeyListQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(tPaginationCursor()),
});

type PersonalAudience = (typeof PERSONAL_API_KEY_AUDIENCES)[number];
type SchemaAudience = NonNullable<
  Static<typeof personalApiKeyBodySchema>["audience"]
>;
true satisfies Exclude<PersonalAudience, SchemaAudience> extends never
  ? true
  : never;
true satisfies Exclude<SchemaAudience, PersonalAudience> extends never
  ? true
  : never;
