import { describe, expect, test } from "bun:test";

import {
  FIND_REPLACE_DIALOG_LEFT,
  FIND_REPLACE_DIALOG_TOP,
  getFindReplaceOverlayStyle,
} from "./findReplaceDialogLayout";

describe("find and replace dialog placement", () => {
  test("starts below the host editor chrome by default", () => {
    expect(getFindReplaceOverlayStyle(undefined).top).toBe(
      FIND_REPLACE_DIALOG_TOP,
    );
  });

  test("stays inside the document viewer rail by default", () => {
    expect(getFindReplaceOverlayStyle(undefined).left).toBe(
      FIND_REPLACE_DIALOG_LEFT,
    );
  });

  test("allows hosts to override the top offset", () => {
    expect(getFindReplaceOverlayStyle({ top: "12rem" }).top).toBe("12rem");
  });

  test("allows hosts to override the left rail", () => {
    expect(getFindReplaceOverlayStyle({ left: "8rem" }).left).toBe("8rem");
  });
});
