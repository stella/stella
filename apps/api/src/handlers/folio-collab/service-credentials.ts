import { Result } from "better-result";

import { env } from "@/api/env";
import type { VerifyCaller } from "@/api/lib/api-handlers";
import {
  authorizeConfiguredBearer,
  type ConfiguredBearerAccess,
} from "@/api/lib/configured-bearer-access";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const toFolioCollabServiceAuthorization = (
  access: ConfiguredBearerAccess,
): Result<void, HandlerError<401 | 404>> => {
  if (access.status === "disabled") {
    return Result.err(
      new HandlerError({ status: 404, message: "Not available" }),
    );
  }
  if (access.status === "unauthorized") {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Invalid collaboration service token",
      }),
    );
  }

  return Result.ok(undefined);
};

const authorizeFolioCollabService = (
  authorizationHeader: string | null,
): Result<void, HandlerError<401 | 404>> => {
  const access = authorizeConfiguredBearer({
    authorizationHeader,
    configuredToken: env.STELLA_COLLAB_SERVICE_TOKEN,
  });
  return toFolioCollabServiceAuthorization(access);
};

/** A snapshot endpoint's caller: the deployment's collaboration service. */
export const verifyFolioCollabServiceCaller: VerifyCaller<void> = ({
  request,
}) => authorizeFolioCollabService(request.headers.get("authorization"));
