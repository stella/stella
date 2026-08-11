import { describe, expect, test } from "bun:test";

import {
  createReviewBasis,
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";

const reference = {
  entityId: "entity-1",
  fileFieldId: "field-1",
  name: "Reference agreement",
  fileName: "reference.docx",
};

describe("document review basis", () => {
  test("makes the empty review basis unrepresentable", () => {
    expect(createReviewBasis({ playbookId: null, references: [] })).toBeNull();
  });

  test("constructs each supported source combination", () => {
    expect(
      createReviewBasis({ playbookId: "playbook-1", references: [] }),
    ).toEqual({ type: "playbook", playbookId: "playbook-1" });
    expect(
      createReviewBasis({ playbookId: null, references: [reference] }),
    ).toEqual({ type: "references", references: [reference] });
    expect(
      createReviewBasis({
        playbookId: "playbook-1",
        references: [reference],
      }),
    ).toEqual({
      type: "combined",
      playbookId: "playbook-1",
      references: [reference],
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
    });

    expect(basis).toEqual({
      type: "references",
      references: [reference, other],
    });
  });

  test("projects sources exhaustively from every basis branch", () => {
    const combined = {
      type: "combined" as const,
      playbookId: "playbook-1",
      references: [reference],
    };

    expect(playbookIdFromBasis(combined)).toBe("playbook-1");
    expect(referencesFromBasis(combined)).toEqual([reference]);
    expect(
      playbookIdFromBasis({ type: "references", references: [reference] }),
    ).toBeNull();
    expect(
      referencesFromBasis({ type: "playbook", playbookId: "playbook-1" }),
    ).toEqual([]);
  });
});
