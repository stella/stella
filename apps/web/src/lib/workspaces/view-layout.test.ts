import { describe, expect, test } from "bun:test";

import { cellCitationViewId, correspondenceViewId } from "./view-layout";

const view = (id: string, type: string) => ({ id, layout: { type } });

describe("the view a correspondence message links back to", () => {
  test("is the matter's correspondence view wherever it sits", () => {
    expect(
      correspondenceViewId([
        view("overview", "overview"),
        view("table", "table"),
        view("mail", "correspondence"),
      ]),
    ).toBe("mail");
  });

  test("falls back to the overview when the matter removed it", () => {
    expect(
      correspondenceViewId([view("table", "table"), view("home", "overview")]),
    ).toBe("home");
  });

  test("falls back to the first view, then to none", () => {
    expect(correspondenceViewId([view("table", "table")])).toBe("table");
    expect(correspondenceViewId([])).toBeNull();
  });
});

describe("the view a cited review cell opens in", () => {
  const table = (id: string, hiddenProperties: string[] = []) => ({
    id,
    layout: { type: "table", hiddenProperties },
  });
  const tree = {
    id: "tree",
    layout: { type: "filesystem", hiddenProperties: [] },
  };
  const views = [tree, table("a", ["cap"]), table("b"), table("c")];

  test("keeps the table on screen when it shows the column", () => {
    expect(cellCitationViewId(views, "cap", "c")).toBe("c");
  });

  test("otherwise takes the first table that shows the column", () => {
    expect(cellCitationViewId(views, "cap", "a")).toBe("b");
    expect(cellCitationViewId(views, "cap", "tree")).toBe("b");
  });

  test("falls back to any table, then to none", () => {
    expect(cellCitationViewId([table("a", ["cap"])], "cap", undefined)).toBe(
      "a",
    );
    expect(cellCitationViewId([tree], "cap", undefined)).toBeNull();
  });
});
