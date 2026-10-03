import { describe, expect, test } from "bun:test";

import { correspondenceViewId } from "./view-layout";

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
