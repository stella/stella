import { describe, expect, test } from "bun:test";

import capabilityCatalog from "@/api/mcp/generated/capability-catalog.json";

describe("style set document capability scopes", () => {
  test("separates Stella Style and custom Style Set consent", () => {
    const stellaStyle = capabilityCatalog.find(
      ({ id }) => id === "entities.create-blank-document",
    );
    const customStyleSet = capabilityCatalog.find(
      ({ id }) => id === "entities.create-document-from-style-set",
    );

    expect(stellaStyle?.scope).toBe("stella:documents_write");
    expect(customStyleSet?.scope).toBe("stella:templates");
    expect(JSON.stringify(stellaStyle?.inputSchema)).not.toContain(
      "styleSetId",
    );
    expect(JSON.stringify(customStyleSet?.inputSchema)).toContain("styleSetId");
  });
});
