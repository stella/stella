import { APIError } from "@better-auth/core/error";
import { Result } from "better-result";
import { expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import { validateUserLocale } from "@/api/lib/auth/user-locale";

test("accepts every exact UI locale", () => {
  for (const locale of UI_LOCALES) {
    expect(Result.isOk(validateUserLocale(locale))).toBe(true);
  }
});

test.each(["en-US", "CS", "", null, 42])(
  "rejects unsupported profile locale %s",
  (locale) => {
    const result = validateUserLocale(locale);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(APIError);
      expect(result.error.status).toBe("BAD_REQUEST");
    }
  },
);

test("allows an omitted locale so the database default applies on account creation", () => {
  expect(Result.isOk(validateUserLocale(undefined))).toBe(true);
});
