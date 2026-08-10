import { describe, expect, test } from "bun:test";

import {
  isOfficeCitationBlockId,
  parseOfficeCitationHref,
} from "./office-citations";

const ENTITY_ID = "0198a70b-c981-7000-8000-000000000001";
const FIELD_ID = "0198a70b-c981-7000-8000-000000000002";

describe("Office citation hrefs", () => {
  test("parses a structurally valid locator reference", () => {
    expect(isOfficeCitationBlockId("pptx-0123456789abcdef")).toBe(true);
    expect(isOfficeCitationBlockId("xlsx-0123456789abcdef")).toBe(true);
    expect(
      parseOfficeCitationHref(
        `#office:${ENTITY_ID}:${FIELD_ID}:xlsx-0123456789abcdef`,
      ),
    ).toEqual({
      blockId: "xlsx-0123456789abcdef",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    });
  });

  test("rejects fabricated or ambiguous block ids", () => {
    expect(isOfficeCitationBlockId("xlsx-0123456789abcde")).toBe(false);
    expect(isOfficeCitationBlockId("xlsx-0123456789abcdef0")).toBe(false);
    expect(isOfficeCitationBlockId("xlsx-0123456789ABCDEF")).toBe(false);
    expect(isOfficeCitationBlockId("docx-0123456789abcdef")).toBe(false);
    expect(
      parseOfficeCitationHref(`#office:${ENTITY_ID}:${FIELD_ID}:xlsx-A1`),
    ).toBeNull();
    expect(
      parseOfficeCitationHref(
        `#office:${ENTITY_ID}:${FIELD_ID}:docx-0123456789abcdef`,
      ),
    ).toBeNull();
    expect(
      parseOfficeCitationHref(
        `https://example.com/#office:${ENTITY_ID}:${FIELD_ID}:xlsx-0123456789abcdef`,
      ),
    ).toBeNull();
    expect(
      parseOfficeCitationHref(
        `#office:${ENTITY_ID.toUpperCase()}:${FIELD_ID}:xlsx-0123456789abcdef`,
      ),
    ).toBeNull();
  });
});
