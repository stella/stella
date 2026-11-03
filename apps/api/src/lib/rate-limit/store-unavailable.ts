import { TaggedError } from "better-result";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import { declareFailureClass } from "@stll/errors";

export class LimiterStoreUnavailableError extends TaggedError(
  "LimiterStoreUnavailableError",
)<{
  message: string;
  operation: "connect" | "command" | "read" | "increment";
  cause?: unknown;
}> {
  static {
    declareFailureClass(this, "limiter_store_unavailable");
  }

  readonly code = LIMITER_STORE_UNAVAILABLE.code;
}
