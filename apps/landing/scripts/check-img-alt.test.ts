import { describe, expect, test } from "bun:test";

import { hasExplicitAlt } from "./check-img-alt";

describe("image alt attribute detection", () => {
  test("accepts alt attributes with HTML whitespace", () => {
    expect(hasExplicitAlt('<img alt="">')).toBe(true);
    expect(hasExplicitAlt("<img\nalt = {description}>")).toBe(true);
  });

  test("rejects prefixed alt-like attributes", () => {
    expect(hasExplicitAlt('<img data-alt="description">')).toBe(false);
    expect(hasExplicitAlt('<img aria-alt="description">')).toBe(false);
  });
});
