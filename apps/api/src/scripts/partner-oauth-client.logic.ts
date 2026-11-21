import type { UnhandledException } from "better-result";
import * as v from "valibot";

import { PartnerClientOperatorError } from "@/api/lib/db/partner-client-operator";

export const PARTNER_CLIENT_USAGE =
  "Usage: create --name <name> --redirect-uri <uri> --secret-sha256 <digest> | rotate --client-id <id> --secret-sha256 <digest> | disable --client-id <id>.";

/**
 * What a failed run may print: fixed messages and option names, never an
 * argument's value or a database error, whose parameters may carry it.
 */
export const describeFailure = ({ cause }: UnhandledException): string => {
  if (cause instanceof PartnerClientOperatorError) {
    return cause.message;
  }
  if (v.isValiError(cause)) {
    const options = [
      ...new Set(
        cause.issues.flatMap((issue) => {
          const key = issue.path?.at(0)?.key;
          return typeof key === "string" ? [`--${key}`] : [];
        }),
      ),
    ];
    const hint = options.includes("--secret-sha256")
      ? " --secret-sha256 takes the clientSecretSha256 value that partner-oauth-client-secret printed."
      : "";
    return options.length > 0
      ? `Missing or invalid: ${options.join(", ")}.${hint} ${PARTNER_CLIENT_USAGE}`
      : `Invalid arguments. ${PARTNER_CLIENT_USAGE}`;
  }
  return "Partner client operation failed.";
};
