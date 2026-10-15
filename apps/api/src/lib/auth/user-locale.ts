import { APIError } from "@better-auth/core/error";
import { Result } from "better-result";

import { isUiLocale } from "@stll/locales";

export const validateUserLocale = (locale: unknown) => {
  if (locale === undefined) {
    return Result.ok(undefined);
  }
  if (!isUiLocale(locale)) {
    return Result.err(
      new APIError("BAD_REQUEST", {
        message: "Locale must be a supported UI locale",
      }),
    );
  }
  return Result.ok(undefined);
};
