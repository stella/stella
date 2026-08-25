import { describe, expect, test } from "bun:test";

import {
  customPerspectiveInput,
  emptyReviewSetup,
  isReviewSetupRunnable,
  isSamePerspective,
  NEUTRAL_PERSPECTIVE,
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
