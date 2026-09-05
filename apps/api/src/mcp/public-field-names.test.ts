import { describe, expect, test } from "bun:test";

import {
  declaresInternalField,
  INTERNAL_FIELD_NAME,
  PUBLIC_FIELD_NAME,
} from "@/api/mcp/public-field-names";

describe("public field names", () => {
  // The two directions gate a wire rename: if either loses an entry (two public
  // names collapsing onto one internal name would), a field would be advertised
  // under a name the inbound path cannot map back, and the call would fail
  // validation against a schema the agent was never shown.
  test("the two directions are bijective", () => {
    expect(
      Object.fromEntries(
        Object.entries(PUBLIC_FIELD_NAME).map(([internal, publicName]) => [
          publicName,
          internal,
        ]),
      ),
    ).toEqual(INTERNAL_FIELD_NAME);
  });

  // A container that is a list of ids is the same container: leaving the plural
  // out advertised `--body-trigger-workspace-ids` next to `--matter-id`.
  test("the plural travels with the singular", () => {
    expect(INTERNAL_FIELD_NAME["matterIds"]).toBe("workspaceIds");
    expect(PUBLIC_FIELD_NAME["workspaceIds"]).toBe("matterIds");
  });
});

describe("declaresInternalField", () => {
  test("a node naming the container internally is projected", () => {
    expect(
      declaresInternalField({
        properties: { workspaceId: { type: "string" } },
      }),
    ).toBe(true);
    expect(
      declaresInternalField({
        properties: { workspaceIds: { type: "array" } },
      }),
    ).toBe(true);
  });

  // The exemption that keeps `expenses.create` working: a handler that already
  // owns the public name has nothing to rename.
  test("a node owning the public name is left alone", () => {
    expect(
      declaresInternalField({ properties: { matterId: { type: "string" } } }),
    ).toBe(false);
  });

  test("an unrelated word that merely starts the same is not the container", () => {
    expect(
      declaresInternalField({
        properties: {
          matterCode: { type: "string" },
          matterNumberPattern: { type: "string" },
          workspaceName: { type: "string" },
        },
      }),
    ).toBe(false);
  });

  test("a non-object node declares nothing", () => {
    for (const node of [undefined, null, "string", 4, [], {}]) {
      expect(declaresInternalField(node)).toBe(false);
    }
  });
});
