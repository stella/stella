import { expect, test } from "bun:test";

import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";
import { DECISION_SEARCH_MATCHES } from "@stll/api-contract/search";

import { filterDefaults, searchView } from "./model";

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

// Every match disposition must survive the view projection unchanged.
test.each(DECISION_SEARCH_MATCHES)(
  "search view retains %s matching",
  (match) => {
    const view = searchView({
      ...APP_SEARCH_FIXTURE,
      results: APP_SEARCH_FIXTURE.results.map((row) => ({ ...row, match })),
    });
    expect(view.type).toBe("search");
    if (view.type !== "search") {
      throw new TypeError("Expected a search view");
    }
    expect(view.results.map((row) => row.match)).toEqual(
      APP_SEARCH_FIXTURE.results.map(() => match),
    );
  },
);
