import { describe, expect, test } from "bun:test";

import {
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
});
