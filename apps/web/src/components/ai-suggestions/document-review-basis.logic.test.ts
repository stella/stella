import { describe, expect, test } from "bun:test";

import {
  customPerspectiveInput,
  emptyReviewSetup,
  isReviewSetupRunnable,
  isSamePerspective,
  NEUTRAL_PERSPECTIVE,
  parseReviewStartMode,
  REVIEW_START_MODE,
  reviewStartModeStorageKey,
} from "@/components/ai-suggestions/document-review-basis.logic";

const reference = {
  workspaceId: "workspace-1",
  workspaceName: null,
  entityId: "entity-1",
  fileFieldId: "field-1",
  name: "Reference agreement",
  fileName: "reference.docx",
};

describe("review setup", () => {
  test("a setup naming neither a playbook nor a reference cannot run", () => {
    expect(isReviewSetupRunnable(emptyReviewSetup())).toBe(false);
  });

  test("either source alone is enough to start", () => {
    expect(
      isReviewSetupRunnable({
        ...emptyReviewSetup(),
        playbookId: "playbook-1",
      }),
    ).toBe(true);
    expect(
      isReviewSetupRunnable({
        ...emptyReviewSetup(),
        references: [reference],
      }),
    ).toBe(true);
  });

  test("compares neutral and party perspectives at their exact boundaries", () => {
    const buyer = { type: "party", role: "Buyer", name: null } as const;

    expect(isSamePerspective(NEUTRAL_PERSPECTIVE, NEUTRAL_PERSPECTIVE)).toBe(
      true,
    );
    expect(isSamePerspective(NEUTRAL_PERSPECTIVE, buyer)).toBe(false);
    expect(isSamePerspective(buyer, NEUTRAL_PERSPECTIVE)).toBe(false);
    expect(isSamePerspective(buyer, buyer)).toBe(true);
    expect(isSamePerspective(buyer, { ...buyer, name: "Northwind GmbH" })).toBe(
      false,
    );
  });

  test("preserves editable spaces while normalising a custom perspective", () => {
    expect(customPerspectiveInput("Purchaser ")).toEqual({
      rawRole: "Purchaser ",
      perspective: { type: "party", role: "Purchaser", name: null },
    });
    expect(customPerspectiveInput("   ")).toEqual({
      rawRole: "   ",
      perspective: NEUTRAL_PERSPECTIVE,
    });
  });
});

describe("review start mode", () => {
  test("reads an unanswered or unrecognised store as starting immediately", () => {
    expect(parseReviewStartMode(null)).toBe(REVIEW_START_MODE.immediate);
    expect(parseReviewStartMode("")).toBe(REVIEW_START_MODE.immediate);
    expect(parseReviewStartMode("yes")).toBe(REVIEW_START_MODE.immediate);
    expect(parseReviewStartMode(REVIEW_START_MODE.immediate)).toBe(
      REVIEW_START_MODE.immediate,
    );
  });

  test("reads a stored confirm-first answer back", () => {
    expect(parseReviewStartMode(REVIEW_START_MODE.confirmFirst)).toBe(
      REVIEW_START_MODE.confirmFirst,
    );
  });

  test("keys the answer to one document, not to the matter", () => {
    expect(reviewStartModeStorageKey("entity-1", "field-1")).not.toBe(
      reviewStartModeStorageKey("entity-1", "field-2"),
    );
    expect(reviewStartModeStorageKey("entity-1", "field-1")).toBe(
      reviewStartModeStorageKey("entity-1", "field-1"),
    );
  });
});
