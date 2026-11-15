import { expect, test } from "bun:test";
import * as v from "valibot";

import { contactBankAccountSchema } from "./contact-write";

test("bank account properties round-trip and unknown properties are rejected", () => {
  const account = {
    iban: "CZ6508000000192000145399",
    bic: "GIBACZPX",
    accountNumber: "19-2000145399/0800",
    bankName: "Bank",
    currency: "czk",
  };
  expect(v.parse(contactBankAccountSchema, account)).toEqual({
    ...account,
    currency: "CZK",
  });
  for (const key of Object.keys(contactBankAccountSchema.entries)) {
    const invalid = { ...account, [`${key}Typo`]: "value" };
    const parsed = v.safeParse(contactBankAccountSchema, invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.type)).toContain(
        "strict_object",
      );
    }
  }
});
