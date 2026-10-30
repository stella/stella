import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
} from "@stll/api-contract/organization-create";

import { getOrganizationSchema } from "@/lib/organization/utils";

describe("organization creation form", () => {
  test("a blank address leaves slug generation to the server", () => {
    const schema = getOrganizationSchema();
    const empty = v.parse(schema, { name: " New firm ", slug: "" });
    expect(empty.name).toBe("New firm");
    expect(empty.slug).toBeUndefined();
    const whitespace = v.parse(schema, { name: " New firm ", slug: " \t\n " });
    expect(whitespace.name).toBe("New firm");
    expect(whitespace.slug).toBeUndefined();
  });

  test("an explicit address is preserved independently of the organization name", () => {
    const schema = getOrganizationSchema();
    const explicit = v.parse(schema, {
      name: " New firm ",
      slug: " selected-address ",
    });
    expect(explicit).toEqual({ name: "New firm", slug: "selected-address" });
    expect(
      v.parse(schema, { name: "Other firm", slug: "selected-address" }).slug,
    ).toBe(explicit.slug);
  });

  test("explicit addresses retain their format and length validation", () => {
    const schema = getOrganizationSchema();
    expect(
      v.safeParse(schema, { name: "New firm", slug: "Not a slug" }).success,
    ).toBe(false);
    expect(
      v.safeParse(schema, {
        name: "New firm",
        slug: "a".repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(schema, {
        name: "a".repeat(ORGANIZATION_NAME_MAX_LENGTH + 1),
        slug: "",
      }).success,
    ).toBe(false);
  });
});
