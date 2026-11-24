import { expect, test } from "bun:test";

import { normalizeMatterSuggestion } from "./matter-suggestion";

test("matter suggestion collapses whitespace and defaults the client type", () => {
  expect(
    normalizeMatterSuggestion({
      name: "  Doležalová v.\n Hrubý  ",
      clientName: "  Kateřina   Doležalová ",
      clientType: null,
    }),
  ).toEqual({
    name: "Doležalová v. Hrubý",
    client: { displayName: "Kateřina Doležalová", type: "person" },
  });
});

test("matter suggestion drops blank values and clips long ones", () => {
  expect(
    normalizeMatterSuggestion({
      name: "x".repeat(300),
      clientName: "   ",
      clientType: "organization",
    }),
  ).toEqual({ name: "x".repeat(256), client: null });
  expect(
    normalizeMatterSuggestion({
      name: " ",
      clientName: null,
      clientType: null,
    }),
  ).toEqual({ name: null, client: null });
  expect(normalizeMatterSuggestion(null)).toBeNull();
});
