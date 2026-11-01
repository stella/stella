import { describe, expect, test } from "bun:test";

import { permittedSearchResultTypes } from "@/api/lib/search/result-type-scopes";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

describe("permittedSearchResultTypes", () => {
  test("a browser session sees every result type", () => {
    expect(permittedSearchResultTypes(undefined)).toEqual(
      GLOBAL_SEARCH_RESULT_TYPES,
    );
  });

  test("stella:read sees every type except chat", () => {
    expect(permittedSearchResultTypes(["stella:read"])).toEqual(
      GLOBAL_SEARCH_RESULT_TYPES.filter((type) => type !== "chat"),
    );
  });

  test("stella:chat adds chat", () => {
    expect(permittedSearchResultTypes(["stella:read", "stella:chat"])).toEqual(
      GLOBAL_SEARCH_RESULT_TYPES,
    );
    expect(permittedSearchResultTypes(["stella:chat"])).toEqual(["chat"]);
  });

  test("a token with neither scope sees nothing", () => {
    expect(permittedSearchResultTypes(["stella:search"])).toEqual([]);
  });
});
