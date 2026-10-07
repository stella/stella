import { expect, test } from "bun:test";

import {
  PROFESSIONAL_USE_STATEMENT_SHA256,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import { sha256Hex } from "@stll/sha256/bun";

import messages from "@/i18n/langs/en.json";

// Accounts record the statement version they were created under, so the
// shown text and the recorded version must not drift apart.
test(`the professional-use statement is the text version ${PROFESSIONAL_USE_STATEMENT_VERSION} names`, () => {
  expect(sha256Hex(messages.auth.professionalUseStatement)).toBe(
    PROFESSIONAL_USE_STATEMENT_SHA256,
  );
});
