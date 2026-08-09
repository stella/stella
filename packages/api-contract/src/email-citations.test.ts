import { describe, expect, test } from "bun:test";

import {
  EMAIL_HEADER_CITATION_ID,
  isEmailCitationBlockId,
  parseEmailCitationHref,
} from "./email-citations";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const FIELD_ID = "22222222-2222-4222-8222-222222222222";

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

  test("parses only source-bound citation hrefs", () => {
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:header-subject`),
    ).toEqual({
      blockId: "header-subject",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    });
    expect(parseEmailCitationHref("#email:bogus")).toBeNull();
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:body-1`),
    ).toBeNull();
  });
});
