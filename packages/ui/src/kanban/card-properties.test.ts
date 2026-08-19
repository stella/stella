import { describe, expect, test } from "bun:test";

import { selectKanbanCardFieldIds } from "./card-properties";

describe("selectKanbanCardFieldIds", () => {
  test("reserved ids are the card's own, so they never repeat as values", () => {
    expect(
      selectKanbanCardFieldIds(["_status", "phase", "_due-date", "owner"], {
        reservedFieldIds: ["_status", "_due-date"],
      }),
    ).toEqual(["phase", "owner"]);
  });

  test("a veto drops a field the board could otherwise render", () => {
    expect(
      selectKanbanCardFieldIds(["phase", "verdict"], {
        reservedFieldIds: [],
        isRenderable: (fieldId) => fieldId !== "verdict",
      }),
    ).toEqual(["phase"]);
  });
});
