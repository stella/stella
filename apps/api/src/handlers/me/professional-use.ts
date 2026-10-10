import { panic, Result } from "better-result";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { readAccountProfessionalUse } from "@/api/lib/auth";
import type { UserProfessionalUseState } from "@/api/lib/auth/professional-use";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** The wire form of an account's professional-use state. */
export const professionalUseResponse = (state: UserProfessionalUseState) => {
  switch (state.status) {
    case PROFESSIONAL_USE_STATUS.accepted:
      return {
        status: state.status,
        statementVersion: state.statementVersion,
        termsVersion: state.termsVersion,
        acceptedAt: state.acceptedAt.toISOString(),
      };
    case PROFESSIONAL_USE_STATUS.required:
      return { status: state.status };
    default:
      state satisfies never;
      return panic("Unhandled professional-use state");
  }
};

// Session-only: an account that has not accepted yet reads its state here,
// before any organization-scoped route admits it.
const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies SessionHandlerConfig;

const readProfessionalUse = createSafeSessionHandler(
  config,
  async function* ({ user }) {
    const state = yield* Result.await(
      Result.tryPromise({
        try: async () => await readAccountProfessionalUse(user.id),
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

export default readProfessionalUse;
