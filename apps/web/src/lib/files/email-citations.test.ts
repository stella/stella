import { describe, expect, test } from "bun:test";

import {
  isKnownEmailCitationTarget,
  isVerifiedEmailCitationTarget,
  parseEmailCitationHref,
  registerEmailCitationBlocks,
} from "@/lib/files/email-citations";

const FIELD_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_ID = "00000000-0000-4000-8000-000000000002";

describe("email citation hrefs", () => {
  test("accepts only source-bound email anchors", () => {
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:body-0042`),
    ).toEqual({
      blockId: "body-0042",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    });
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:header-subject`),
    ).toEqual({
      blockId: "header-subject",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    });
  });

  test("rejects malformed, unbound, and unknown anchors", () => {
    expect(parseEmailCitationHref("#email:body-0001")).toBeNull();
    expect(parseEmailCitationHref("#email:not-a-field:body-0001")).toBeNull();
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:body-1`),
    ).toBeNull();
    expect(
      parseEmailCitationHref(`#email:${ENTITY_ID}:${FIELD_ID}:attachment-0001`),
    ).toBeNull();
  });

  test("recognizes only blocks registered by the active email viewer", () => {
    const knownTarget = {
      blockId: "body-0001",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    };
    const cleanup = registerEmailCitationBlocks({
      blockIds: [knownTarget.blockId],
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    });

    expect(isKnownEmailCitationTarget(knownTarget)).toBe(true);
    expect(
      isKnownEmailCitationTarget({
        blockId: "body-9999",
        entityId: ENTITY_ID,
        fieldId: FIELD_ID,
      }),
    ).toBe(false);
    expect(
      isKnownEmailCitationTarget({
        blockId: knownTarget.blockId,
        entityId: "00000000-0000-4000-8000-000000000003",
        fieldId: FIELD_ID,
      }),
    ).toBe(false);
    cleanup();
    expect(isKnownEmailCitationTarget(knownTarget)).toBe(false);
  });

  test("requires both the exact source field and a server-returned block", () => {
    const target = {
      blockId: "body-0001",
      entityId: ENTITY_ID,
      fieldId: FIELD_ID,
    };
    expect(
      isVerifiedEmailCitationTarget({
        blockIds: [target.blockId],
        source: { entityId: target.entityId, fieldId: target.fieldId },
        target,
      }),
    ).toBe(true);
    expect(
      isVerifiedEmailCitationTarget({
        blockIds: ["body-9999"],
        source: { entityId: target.entityId, fieldId: target.fieldId },
        target,
      }),
    ).toBe(false);
    expect(
      isVerifiedEmailCitationTarget({
        blockIds: [target.blockId],
        source: {
          entityId: target.entityId,
          fieldId: "00000000-0000-4000-8000-000000000099",
        },
        target,
      }),
    ).toBe(false);
    expect(
      isVerifiedEmailCitationTarget({
        blockIds: [target.blockId],
        source: {
          entityId: "00000000-0000-4000-8000-000000000099",
          fieldId: target.fieldId,
        },
        target,
      }),
    ).toBe(false);
  });
});
