import { describe, expect, test } from "bun:test";

import {
  isKnownEmailCitationTarget,
  parseEmailCitationHref,
  registerEmailCitationBlocks,
} from "@/lib/files/email-citations";

const FIELD_ID = "00000000-0000-4000-8000-000000000001";

describe("email citation hrefs", () => {
  test("accepts only source-bound email anchors", () => {
    expect(parseEmailCitationHref(`#email:${FIELD_ID}:body-0042`)).toEqual({
      blockId: "body-0042",
      fieldId: FIELD_ID,
    });
    expect(parseEmailCitationHref(`#email:${FIELD_ID}:header-subject`)).toEqual(
      { blockId: "header-subject", fieldId: FIELD_ID },
    );
  });

  test("rejects malformed, unbound, and unknown anchors", () => {
    expect(parseEmailCitationHref("#email:body-0001")).toBeNull();
    expect(parseEmailCitationHref("#email:not-a-field:body-0001")).toBeNull();
    expect(parseEmailCitationHref(`#email:${FIELD_ID}:body-1`)).toBeNull();
    expect(
      parseEmailCitationHref(`#email:${FIELD_ID}:attachment-0001`),
    ).toBeNull();
  });

  test("recognizes only blocks registered by the active email viewer", () => {
    const knownTarget = { blockId: "body-0001", fieldId: FIELD_ID };
    const cleanup = registerEmailCitationBlocks({
      blockIds: [knownTarget.blockId],
      fieldId: FIELD_ID,
    });

    expect(isKnownEmailCitationTarget(knownTarget)).toBe(true);
    expect(
      isKnownEmailCitationTarget({
        blockId: "body-9999",
        fieldId: FIELD_ID,
      }),
    ).toBe(false);
    cleanup();
    expect(isKnownEmailCitationTarget(knownTarget)).toBe(false);
  });
});
