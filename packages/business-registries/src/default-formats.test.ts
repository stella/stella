import { describe, expect, test } from "bun:test";

import {
  parseRegistryFormatMarkdown,
  stripRegistryFormatMarkdown,
} from "./default-formats";

describe("registry format markdown", () => {
  test("parses supported emphasis for rich previews", () => {
    expect(
      parseRegistryFormatMarkdown("**ACME PLC**, an *active* company"),
    ).toEqual([
      { text: "ACME PLC", style: "bold", start: 0 },
      { text: ", an ", style: "plain", start: 12 },
      { text: "active", style: "italic", start: 17 },
      { text: " company", style: "plain", start: 25 },
    ]);
  });

  test("removes emphasis markers from plain-text clipboard output", () => {
    expect(
      stripRegistryFormatMarkdown("**ACME PLC**, an *active* company"),
    ).toBe("ACME PLC, an active company");
  });
});
