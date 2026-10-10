import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import { readOperatorRegistrationPage } from "@/api/db/root";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { authorizeConfiguredBearer } from "@/api/lib/configured-bearer-access";
import { parseRegistrationQuery } from "@/api/lib/db/operator-registrations/input";
import type { readAuditedRegistrationPage } from "@/api/lib/db/operator-registrations/read";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { permissiveRouteSchema } from "@/api/lib/permissive-route-schema";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";

export type OperatorRegistrationsOptions = {
  configuredToken: () => string | undefined;
  readPage: (
    query: Parameters<typeof readAuditedRegistrationPage>[1],
  ) => ReturnType<typeof readAuditedRegistrationPage>;
  now?: () => number;
};

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  query: permissiveRouteSchema({ keys: ["since", "cursor", "limit"] }),
} satisfies TokenHandlerConfig;

export const createOperatorRegistrations = ({
  configuredToken,
  readPage,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OperatorRegistrationsOptions) =>
  createSafeTokenHandler(config, async function* ({ request, query, set }) {
    applyResponseCachePolicy({
      cache: { kind: "none" },
      response: undefined,
      set,
    });
    const access = authorizeConfiguredBearer({
      authorizationHeader: request.headers.get("authorization"),
      configuredToken: configuredToken(),
    });
    switch (access.status) {
      case "disabled":
        logger.info("operator.registrations.refused", {
          "access.status": access.status,
        });
        return Result.err(
          new HandlerError({ status: 404, message: "Not available" }),
        );
      case "unauthorized":
        logger.info("operator.registrations.refused", {
          "access.status": access.status,
        });
        return Result.err(
          new HandlerError({ status: 401, message: "Unauthorized" }),
        );
      case "authorized":
        break;
      default:
        access satisfies never;
        return panic("Unhandled operator access status");
    }
    const parsed = yield* parseRegistrationQuery({ query, now: now() });
    return Result.ok(await readPage(parsed));
  });

const operatorRegistrations = createOperatorRegistrations({
  configuredToken: () => env.OPERATOR_API_TOKEN,
  readPage: readOperatorRegistrationPage,
});

export default operatorRegistrations;
