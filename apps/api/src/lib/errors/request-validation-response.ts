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
          field: t.String(),
          constraint: t.UnionEnum(API_VALIDATION_CONSTRAINTS),
          limit: t.Optional(t.Number()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
