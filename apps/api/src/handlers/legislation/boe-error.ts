import {
  BoeAPIError,
  BoeNotFoundError,
  BoeRequestError,
  BoeValidationError,
} from "@stll/boe";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isRetryLaterStatus } from "@/api/lib/errors/upstream-status";

export const mapBoeError = (error: unknown): HandlerError => {
  if (error instanceof BoeValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof BoeNotFoundError) {
    return new HandlerError({ status: 404, message: error.message });
  }
  if (error instanceof BoeAPIError) {
    const { httpStatus } = error;
    if (
      httpStatus >= 400 &&
      httpStatus < 600 &&
      isRetryLaterStatus(httpStatus)
    ) {
      return new HandlerError({
        code: "upstream_unavailable",
        status: 502,
        message: "BOE is temporarily unavailable; retry later",
        cause: error,
      });
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      return new HandlerError({
        status: 400,
        message:
          "BOE rejected the request. Check the identifier and filters before retrying.",
        cause: error,
      });
    }
    return new HandlerError({
      status: 500,
      message: "BOE returned an invalid response",
      cause: error,
    });
  }
  if (error instanceof BoeRequestError) {
    return new HandlerError({
      code: "upstream_unavailable",
      status: 502,
      message: "BOE is temporarily unavailable",
      cause: error,
    });
  }
  return new HandlerError({
    status: 500,
    message: "BOE lookup failed",
    cause: error,
  });
};
