import { describe, expect, test } from "bun:test";

import { getMatterOrganizationResetPatch } from "./-organization-reset";

describe("getMatterOrganizationResetPatch", () => {
  test("clears organization-scoped matter visibility state", () => {
    expect(getMatterOrganizationResetPatch()).toEqual({
      collapsedGroups: [],
      filters: {},
    });
  });
});
