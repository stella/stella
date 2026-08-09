import { describe, expect, test } from "bun:test";

import {
  EMAIL_HEADER_CITATION_ID,
  isEmailCitationBlockId,
} from "./email-citations";

describe("email citation block IDs", () => {
  test("accepts every declared header ID", () => {
    for (const id of Object.values(EMAIL_HEADER_CITATION_ID)) {
      expect(isEmailCitationBlockId(id)).toBe(true);
    }
  });

  test("accepts only four-digit body IDs", () => {
    expect(isEmailCitationBlockId("body-0001")).toBe(true);
    expect(isEmailCitationBlockId("body-0160")).toBe(true);
    expect(isEmailCitationBlockId("body-1")).toBe(false);
    expect(isEmailCitationBlockId("body-00001")).toBe(false);
  });

  test("rejects unknown header IDs", () => {
    expect(isEmailCitationBlockId("header-reply-to")).toBe(false);
  });
});
