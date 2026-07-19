import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { operatorReadDb } from "@/api/lib/operator-read-db";

import {
  authorizeOperatorAccess,
  queryRegistrationsPage,
  readRegistrationsQuerySchema,
  validateRegistrationsFilter,
} from "./query";

const config = {
  mcp: { type: "internal", reason: "health_infra" },
  query: readRegistrationsQuerySchema,
} satisfies TokenHandlerConfig;

export type ReadRegistrationsDeps = {
  getConfiguredToken: () => string | undefined;
  safeDb: SafeDb;
};

/**
 * Operator observability: recent account registrations on this instance.
 * Self-hosting is first-class, and operators need to see who signed up
 * recently (e.g. to confirm invited colleagues completed registration)
 * without opening a database shell.
 *
 * Access model mirrors the smoke endpoint: the route only functions when
 * `OPERATOR_METRICS_TOKEN` is configured (unset → 404, indistinguishable
 * from a missing feature), and the caller must present the token as a
 * bearer credential (mismatch → 401). The dependency seam exists so tests
 * can exercise the full route without a live database or env mutation.
 */
export const createReadRegistrationsEndpoint = ({
  getConfiguredToken,
  safeDb,
}: ReadRegistrationsDeps) =>
  createSafeTokenHandler(config, async function* ({ query, request }) {
    const access = authorizeOperatorAccess({
      configuredToken: getConfiguredToken(),
      authorizationHeader: request.headers.get("authorization"),
    });
    if (access.status === "disabled") {
      return Result.err(
        new HandlerError({ status: 404, message: "Not available" }),
      );
    }
    if (access.status === "unauthorized") {
      return Result.err(
        new HandlerError({ status: 401, message: "Invalid operator token" }),
      );
    }

    const validated = validateRegistrationsFilter(query, new Date());
    if (!validated.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: validated.message }),
      );
    }

    const page = yield* queryRegistrationsPage({
      safeDb,
      filter: validated.filter,
    });
    if (Result.isOk(page)) {
      // Counts only: registration emails/names must never reach logs.
      logger.info("operator.registrations_read", {
        "operator.item_count": page.value.items.length,
      });
    }
    return page;
  });

const readRegistrations = createReadRegistrationsEndpoint({
  getConfiguredToken: () => env.OPERATOR_METRICS_TOKEN,
  safeDb: operatorReadDb,
});

export default readRegistrations;
