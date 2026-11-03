import { describe, expect, test } from "bun:test";

import {
  isNon2xxStatus,
  networkRequestLabel,
} from "../helpers/scenario-diagnostics";

describe("scenario network diagnostics", () => {
  test("records every status outside the successful range", () => {
    expect([199, 200, 299, 300, 500].filter(isNon2xxStatus)).toEqual([
      199, 300, 500,
    ]);
  });

  test("identifies a request without leaking its query or fragment", () => {
    expect(
      networkRequestLabel(
        "POST",
        "https://api.example.test/v1/uploads?token=secret#fragment",
      ),
    ).toBe("POST https://api.example.test/v1/uploads");
  });
});
