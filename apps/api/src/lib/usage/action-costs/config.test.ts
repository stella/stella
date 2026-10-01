import { Result } from "better-result";
import { expect, test } from "bun:test";

import { parseActionCostRates } from "./config";

test("cost settings accept arbitrary operator rates and reject malformed or unsafe values", () => {
  expect(parseActionCostRates('{"fixture":19}')).toMatchObject({
    value: { fixture: 19 },
  });
  expect(parseActionCostRates(undefined)).toMatchObject({ value: {} });
  for (const invalid of [
    '{"fixture":-1}',
    '{"fixture":1.2}',
    '{"fixture":"5"}',
    "null",
    "[]",
    '{"fixture":9007199254740992}',
    "{",
  ]) {
    expect(Result.isError(parseActionCostRates(invalid))).toBe(true);
  }
});
