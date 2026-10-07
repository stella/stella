import { Result } from "better-result";
import { t } from "elysia";

import { PROFESSIONAL_USE_STATEMENT_VERSION } from "@stll/api-contract/professional-use";

import { professionalUseResponse } from "@/api/handlers/me/professional-use";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { acceptAccountProfessionalUse } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const STATEMENT_VERSION_MAX_LENGTH = 32;

// The client names the statement version it showed, so an outdated page
// cannot record acceptance of a statement it did not display.
const requestBody = t.Object(
  { statementVersion: t.String({ maxLength: STATEMENT_VERSION_MAX_LENGTH }) },
  { additionalProperties: false },
);

// Session-only and open to restricted accounts: an operator-created account
// accepts here on its first interactive sign-in.
const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  body: requestBody,
} satisfies SessionHandlerConfig;

const acceptProfessionalUse = createSafeSessionHandler(
  config,
  async function* ({ body: { statementVersion }, user }) {
    if (statementVersion !== PROFESSIONAL_USE_STATEMENT_VERSION) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "professional_use_statement_outdated",
          message:
            "The professional-use statement has changed. Reload the page to read the current one.",
        }),
      );
    }
    const state = yield* Result.await(
      Result.tryPromise({
        try: async () => await acceptAccountProfessionalUse(user.id),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(professionalUseResponse(state));
  },
);

export default acceptProfessionalUse;
