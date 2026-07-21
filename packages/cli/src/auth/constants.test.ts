import { describe, expect, test } from "bun:test";

import { CLI_KNOWN_SCOPES } from "./constants.js";

describe("CLI OAuth scopes", () => {
  test("includes the contacts tool scope", () => {
    expect(CLI_KNOWN_SCOPES).toContain("stella:contacts_write");
  });

  test("includes the feedback tool scope", () => {
    expect(CLI_KNOWN_SCOPES).toContain("stella:feedback");
  });

  test("includes the chat capability scope", () => {
    expect(CLI_KNOWN_SCOPES).toContain("stella:chat");
  });
});
