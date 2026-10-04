import { expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import { sellerSelection } from "./number-series-seller-picker.logic";

test("organization-wide selection needs no seller lookup", () => {
  expect(
    sellerSelection({ value: null, profileName: undefined, error: null }),
  ).toEqual({ type: "all" });
});

test("a seller loaded from the list or its detail has a name", () => {
  expect(
    sellerSelection({
      value: "seller-main",
      profileName: "Main seller",
      error: null,
    }),
  ).toEqual({ type: "profile", name: "Main seller" });
});

test("an unresolved seller is loading until its detail responds", () => {
  expect(
    sellerSelection({
      value: "seller-main",
      profileName: undefined,
      error: null,
    }),
  ).toEqual({ type: "loading" });
});

test("archived sellers are unavailable even when a previous name remains cached", () => {
  const error = new APIError({
    status: 404,
    message: "Seller profile not found",
  });
  for (const profileName of [undefined, "Previously active seller"]) {
    expect(
      sellerSelection({ value: "seller-main", profileName, error }),
    ).toEqual({ type: "unavailable" });
  }
});

test("lookup failures cannot masquerade as archived sellers or remain loading", () => {
  for (const status of [403, 500]) {
    const error = new APIError({ status, message: "Lookup failed" });
    expect(
      sellerSelection({ value: "seller-main", profileName: undefined, error }),
    ).toEqual({ type: "error" });
  }
});
