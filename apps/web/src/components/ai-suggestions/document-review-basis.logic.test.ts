import { describe, expect, test } from "bun:test";

import {
  createReviewBasis,
  customPerspectiveInput,
  isSamePerspective,
  NEUTRAL_PERSPECTIVE,
  perspectiveFromBasis,
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";

const reference = {
  workspaceId: "workspace-1",
  workspaceName: null,
  entityId: "entity-1",
  fileFieldId: "field-1",
  name: "Reference agreement",
  fileName: "reference.docx",
};

describe("document review basis", () => {
  test("makes the empty review basis unrepresentable", () => {
    expect(
      createReviewBasis({
        playbookId: null,
        references: [],
        perspective: NEUTRAL_PERSPECTIVE,
      }),
    ).toBeNull();
  });

  test("constructs each supported source combination", () => {
    const perspective = { type: "party", role: "Buyer", name: null } as const;
    expect(
      createReviewBasis({
        playbookId: "playbook-1",
        references: [],
        perspective,
      }),
    ).toEqual({ type: "playbook", playbookId: "playbook-1" });
    expect(
      createReviewBasis({
        playbookId: null,
        references: [reference],
        perspective,
      }),
    ).toEqual({ type: "references", references: [reference], perspective });
    expect(
      createReviewBasis({
        playbookId: "playbook-1",
        references: [reference],
        perspective,
      }),
    ).toEqual({
      type: "combined",
      playbookId: "playbook-1",
      references: [reference],
      perspective,
    });
  });

  test("deduplicates references without changing their first-seen order", () => {
    const other = {
      ...reference,
      entityId: "entity-2",
      fileFieldId: "field-2",
    };
    const basis = createReviewBasis({
      playbookId: null,
      references: [reference, other, reference],
      perspective: NEUTRAL_PERSPECTIVE,
    });

    expect(basis).toEqual({
      type: "references",
      references: [reference, other],
      perspective: NEUTRAL_PERSPECTIVE,
    });
  });

  test("projects sources exhaustively from every basis branch", () => {
    const combined = {
      type: "combined" as const,
      playbookId: "playbook-1",
      references: [reference],
      perspective: NEUTRAL_PERSPECTIVE,
    };

    expect(playbookIdFromBasis(combined)).toBe("playbook-1");
    expect(referencesFromBasis(combined)).toEqual([reference]);
    expect(
      playbookIdFromBasis({
        type: "references",
        references: [reference],
        perspective: NEUTRAL_PERSPECTIVE,
      }),
    ).toBeNull();
    expect(
      referencesFromBasis({ type: "playbook", playbookId: "playbook-1" }),
    ).toEqual([]);
  });

  test("projects a playbook-only review to the neutral perspective", () => {
    expect(
      perspectiveFromBasis({ type: "playbook", playbookId: "playbook-1" }),
    ).toEqual(NEUTRAL_PERSPECTIVE);
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
