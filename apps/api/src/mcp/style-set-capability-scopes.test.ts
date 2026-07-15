import { describe, expect, test } from "bun:test";

import capabilityCatalog from "@/api/mcp/generated/capability-catalog.json";

describe("style set document capability scopes", () => {
  test("keeps compound custom Style Set consent out of the catalog", () => {
    const stellaStyle = capabilityCatalog.find(
      ({ id }) => id === "entities.create-blank-document",
    );
    const customStyleSet = capabilityCatalog.find(
      ({ id }) => id === "entities.create-document-from-style-set",
    );

    expect(stellaStyle?.scope).toBe("stella:documents_write");
    expect(customStyleSet).toBeUndefined();
    expect(JSON.stringify(stellaStyle?.inputSchema)).not.toContain(
      "styleSetId",
    );
  });
});
