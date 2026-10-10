import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { currencyCodeSchema } from "./currency-code";

describe("currency code validation", () => {
  test.each(["USD", "JPY", "ZZZ"])(
    "accepts uppercase alphabetic codes: %s",
    (code) => {
      expect(v.parse(currencyCodeSchema, code)).toBe(code);
    },
  );
  test.each(["usd", "jPy", "A1C", "US", "USDD", " USD", "USD ", "", "USD\n"])(
    "rejects codes that cannot be submitted to the API: %j",
    (code) => {
      expect(v.safeParse(currencyCodeSchema, code).success).toBe(false);
    },
  );
});
