import { describe, expect, test } from "bun:test";

import { parseHealthCommit } from "./check-api-deployment";

describe("API deployment health receipt", () => {
  test("accepts only a full lowercase commit SHA", () => {
    expect(
      parseHealthCommit({
        commit: "7a1b25220298e7b93d38c1d949ef77b93f86bf84",
        status: "ok",
      }),
    ).toBe("7a1b25220298e7b93d38c1d949ef77b93f86bf84");
    expect(parseHealthCommit({ commit: "7a1b252" })).toBeUndefined();
    expect(
      parseHealthCommit({
        commit: "7A1B25220298E7B93D38C1D949EF77B93F86BF84",
      }),
    ).toBeUndefined();
  });

  test("rejects malformed health payloads", () => {
    expect(parseHealthCommit(undefined)).toBeUndefined();
    expect(parseHealthCommit([])).toBeUndefined();
    expect(parseHealthCommit({ status: "ok" })).toBeUndefined();
  });
});
