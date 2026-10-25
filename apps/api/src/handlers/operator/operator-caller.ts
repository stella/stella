import { panic, Result } from "better-result";

import type { VerifyCaller } from "@/api/lib/api-handlers";
import { authorizeConfiguredBearer } from "@/api/lib/configured-bearer-access";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

type VerifyOperatorCallerOptions = {
  /** The log event a refused call is recorded under. */
  refusedEvent: "operator.activity.refused" | "operator.registrations.refused";
  configuredToken: () => string | undefined;
};

/**
 * An operator endpoint's caller: the deployment's operator bearer token. An
 * unconfigured token hides the endpoint behind a 404.
 */
export const verifyOperatorCaller =
  ({
    refusedEvent,
    configuredToken,
  }: VerifyOperatorCallerOptions): VerifyCaller<void> =>
  ({ request }) => {
    const access = authorizeConfiguredBearer({
      authorizationHeader: request.headers.get("authorization"),
      configuredToken: configuredToken(),
    });
    switch (access.status) {
      case "disabled":
        logger.info(refusedEvent, { "access.status": access.status });
        return Result.err(
          new HandlerError({ status: 404, message: "Not available" }),
        );
      case "unauthorized":
        logger.info(refusedEvent, { "access.status": access.status });
        return Result.err(
          new HandlerError({ status: 401, message: "Unauthorized" }),
        );
      case "authorized":
        return Result.ok(undefined);
      default:
        access satisfies never;
        return panic("Unhandled operator access status");
    }
  };
