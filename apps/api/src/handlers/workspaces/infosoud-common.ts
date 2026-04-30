import {
  InfoSoudAPIError,
  InfoSoudClient,
  InfoSoudParseError,
  InfoSoudRequestError,
} from "@stll/infosoud";
import { t } from "elysia";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const infosoudLookupBodySchema = t.Object({
  courtCode: t.String({ minLength: 1, maxLength: 16 }),
  spisZn: t.String({ minLength: 1, maxLength: 64 }),
});

export const createInfoSoudClient = () => new InfoSoudClient({ cache: false });

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

  if (error instanceof InfoSoudRequestError) {
    if (error.message.startsWith("Cannot resolve Prague district court")) {
      return new HandlerError({
        status: 404,
        message: "InfoSoud case not found",
        cause: error,
      });
    }

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
