import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { validateToken } from "./jwks-validator";

describe("validateToken", () => {
  test("rejects invalid token", async () => {
    const result = await validateToken("invalid", "http://localhost:3001");
    expect(Result.isError(result)).toBe(true);
  });
});
