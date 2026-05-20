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
    return new HandlerError({
      status: 502,
      message: `BOE API error: ${error.message}`,
    });
  }
  if (error instanceof BoeRequestError) {
    return new HandlerError({
      status: 502,
      message: `BOE request failed: ${error.message}`,
    });
  }
  return new HandlerError({
    status: 500,
    message: "BOE lookup failed",
    cause: error,
  });
};
