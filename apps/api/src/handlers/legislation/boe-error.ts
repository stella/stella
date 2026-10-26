import {
  BoeAPIError,
  BoeNotFoundError,
  BoeRequestError,
  BoeValidationError,
} from "@stll/boe";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const mapBoeError = (error: unknown): HandlerError => {
  if (error instanceof BoeValidationError) {
    return new HandlerError({ status: 400, message: error.message });
  }
  if (error instanceof BoeNotFoundError) {
    return new HandlerError({ status: 404, message: error.message });
  }
  if (error instanceof BoeAPIError) {
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      return new HandlerError({
        status: 400,
        message:
          "BOE rejected the request. Check the identifier and filters before retrying.",
        cause: error,
      });
    }
    if (error.httpStatus < 500 || error.httpStatus >= 600) {
      return new HandlerError({
        status: 500,
        message: "BOE returned an invalid response",
        cause: error,
      });
    }
    return new HandlerError({
      code: "upstream_unavailable",
      status: 502,
      message: "BOE is temporarily unavailable",
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
