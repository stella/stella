import { expect, test } from "bun:test";

import {
  PROFESSIONAL_USE_STATEMENT_SHA256,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";

import messages from "@/i18n/langs/en.json";

// Accounts record the statement version they were created under, so the
// shown text and the recorded version must not drift apart.
test(`the professional-use statement is the text version ${PROFESSIONAL_USE_STATEMENT_VERSION} names`, () => {
  const digest = new Bun.CryptoHasher("sha256")
    .update(messages.auth.professionalUseStatement)
    .digest("hex");
  expect(digest).toBe(PROFESSIONAL_USE_STATEMENT_SHA256);
});
