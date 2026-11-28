import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  HandlerErrorProps,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";

// Gateway and availability failures must declare their machine-readable meaning.
export const availabilityFailuresRequireCode = (
  status: HandlerErrorStatusCode,
) => {
  // @ts-expect-error An untagged gateway failure cannot be constructed.
  const gateway = new HandlerError({ status: 502, message: "Unavailable" });
  // @ts-expect-error An untagged availability failure cannot be constructed.
  const availability = new HandlerError({
    status: 503,
    message: "Unavailable",
  });
  // @ts-expect-error Explicitly widening the generic cannot evade the guard.
  const widened = new HandlerError<HandlerErrorStatusCode>({
    status: 502,
    message: "Unavailable",
  });
  const optional = new HandlerError({
    status: 502,
    // @ts-expect-error An optional code cannot classify a gateway failure.
    code: undefined,
    message: "Unavailable",
  });
  // @ts-expect-error Dynamic statuses that may be 502/503 need a code too.
  const dynamic = new HandlerError({ status, message: "Unavailable" });
  // @ts-expect-error The props contract also rejects an untagged 502.
  const untagged: HandlerErrorProps = { status: 502, message: "Unavailable" };

  const upstream = new HandlerError({
    status: 502,
    code: "upstream_unavailable",
    message: "Unavailable",
    cause: new TypeError("Transport failure"),
  });
  const configuration = new HandlerError({
    status: 503,
    code: "configuration_unavailable",
    message: "Configuration unavailable",
  });
  const internal = new HandlerError({
    status: 500,
    message: "Internal failure",
  });
  const caller = new HandlerError({ status: 400, message: "Invalid request" });

  // Unregistered or typo'd refusal codes must fail at compile time.
  const unregistered4xx = new HandlerError({
    status: 400,
    // @ts-expect-error Arbitrary string codes are rejected by the closed ApiRefusalCode union.
    code: "unregistered_typo",
    message: "Invalid request",
  });
  const typo404 = new HandlerError({
    status: 404,
    // @ts-expect-error Typos in known codes are rejected by the closed ApiRefusalCode union.
    code: "not_foud",
    message: "Not found",
  });
  const unregistered502 = new HandlerError({
    status: 502,
    // @ts-expect-error Gateway failures must use a registered ApiRefusalCode or GatewayErrorCode.
    code: "unregistered_gateway_typo",
    message: "Unavailable",
  });
  return {
    unregistered4xx,
    typo404,
    unregistered502,
    gateway,
    availability,
    widened,
    optional,
    dynamic,
    untagged,
    upstream,
    configuration,
    internal,
    caller,
  };
};
