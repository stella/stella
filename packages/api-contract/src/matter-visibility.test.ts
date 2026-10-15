import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MATTER_VISIBILITY,
  defaultMatterVisibilityFor,
  MATTER_VISIBILITY,
} from "./matter-visibility";

describe("defaultMatterVisibilityFor", () => {
  test("a matter without a client is visible only to its assigned members", () => {
    expect(defaultMatterVisibilityFor({ hasClient: false })).toBe(
      MATTER_VISIBILITY.assignedOnly,
    );
  });

  test("a client matter follows the client default", () => {
    expect(defaultMatterVisibilityFor({ hasClient: true })).toBe(
      DEFAULT_MATTER_VISIBILITY,
    );
    expect(DEFAULT_MATTER_VISIBILITY).toBe(MATTER_VISIBILITY.adminsAndAssigned);
  });
});
