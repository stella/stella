import { expect, test } from "bun:test";

import { DIRECTLY_CREATABLE_VIEW_LAYOUTS } from "./view-layout";

test("the add-view menu offers AVT directly; timeline stays preset-only", () => {
  expect(DIRECTLY_CREATABLE_VIEW_LAYOUTS).toContain("avt");
  expect(DIRECTLY_CREATABLE_VIEW_LAYOUTS).not.toContain("timeline");
});
