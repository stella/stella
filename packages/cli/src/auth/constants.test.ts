import { describe, expect, test } from "bun:test";

import { CLI_KNOWN_SCOPES } from "./constants.js";

describe("CLI OAuth scopes", () => {
  test("includes the feedback tool scope", () => {
    expect(CLI_KNOWN_SCOPES).toContain("stella:feedback");
  });
});
