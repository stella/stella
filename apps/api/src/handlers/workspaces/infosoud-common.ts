import * as v from "valibot";

import {
  InfoSoudAPIError,
  InfoSoudParseError,
  InfoSoudPragueCourtResolutionError,
  InfoSoudRequestError,
} from "@stll/infosoud";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export { getInfoSoudClient } from "@/api/lib/infosoud/client";

export const infosoudLookupBodySchema = v.object({
  courtCode: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  spisZn: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});

export const toInfoSoudLookupError = (error: unknown): HandlerError => {
  if (error instanceof InfoSoudParseError) {
    return new HandlerError({
      status: 400,
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof InfoSoudAPIError) {
    return new HandlerError({
      status: error.status === 400 ? 404 : 502,
      message:
        error.status === 400
          ? "InfoSoud case not found"
          : "InfoSoud returned an error",
      cause: error,
    });
  }

  if (error instanceof InfoSoudPragueCourtResolutionError) {
    return new HandlerError({
      status: 404,
      message: "InfoSoud case not found",
      cause: error,
    });
  }

  if (error instanceof InfoSoudRequestError) {
    return new HandlerError({
      status: 502,
      message: "InfoSoud request failed",
      cause: error,
    });
  }

  return new HandlerError({
    status: 500,
    message: "InfoSoud lookup failed",
    cause: error,
  });
};
