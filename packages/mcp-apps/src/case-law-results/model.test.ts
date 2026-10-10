import { expect, test } from "bun:test";

import { filterDefaults } from "./model";

test.each([
  [{ country: "invalid" }, "invalidCountry"],
  [{ country: "CZE", date_from: "invalid" }, "invalidDateFrom"],
  [{ country: "CZE", date_to: "invalid" }, "invalidDateTo"],
  [{ country: "CZE", courts: [1] }, "invalidCourts"],
] as const)(
  "invalid filter values return a catalog key rather than an English agent hint: %j",
  (input, messageKey) => {
    expect(filterDefaults(input)).toEqual({ status: "invalid", messageKey });
  },
);
