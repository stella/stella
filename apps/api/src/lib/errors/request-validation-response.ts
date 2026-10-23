import { t } from "elysia";

import {
  API_VALIDATION_CONSTRAINTS,
  API_VALIDATION_ERROR_CODE,
} from "@stll/api-contract";

/** The sanitized field issues emitted by elysiaErrorBody for rejected requests. */
export const requestValidationResponseSchema = t.Object(
  {
    message: t.Literal("Invalid request"),
    code: t.Literal(API_VALIDATION_ERROR_CODE),
    issues: t.Array(
      t.Object(
        {
          field: t.String({ maxLength: 500 }),
          constraint: t.UnionEnum(API_VALIDATION_CONSTRAINTS),
          limit: t.Optional(t.Number()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** The framework-owned envelope emitted before the application's error mapper. */
export const frameworkRequestValidationResponseSchema = t.Union([
  requestValidationResponseSchema,
  t.Object(
    {
      type: t.Literal("validation"),
      on: t.String({ maxLength: 32 }),
      property: t.Optional(t.Unknown()),
      message: t.Optional(t.String({ maxLength: 4096 })),
      summary: t.Optional(t.String({ maxLength: 4096 })),
      expected: t.Optional(t.Unknown()),
      found: t.Optional(t.Unknown()),
      errors: t.Optional(t.Unknown()),
    },
    { additionalProperties: false },
  ),
]);
