import { describe, expect, test } from "bun:test";

import { isOfficeDialogApi } from "@/lib/office";

describe("Office dialog capability", () => {
  test("treats a partial browser Office context as unavailable", () => {
    expect(isOfficeDialogApi(undefined)).toBe(false);
    expect(isOfficeDialogApi(null)).toBe(false);
    expect(isOfficeDialogApi({})).toBe(false);
  });

  test("accepts a structurally valid dialog API", () => {
    expect(
      isOfficeDialogApi({ displayDialogAsync: () => undefined }),
    ).toBe(true);
  });
});
