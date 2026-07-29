import { describe, expect, test } from "bun:test";

import capabilityCatalog from "@/api/mcp/generated/capability-catalog.json";

describe("template persistence capability scope parity", () => {
  test("fill-to-workspace requires the same document-write consent as its covering tool", () => {
    const fillToWorkspace = capabilityCatalog.find(
      ({ id }) => id === "templates.fill-to-workspace",
    );

    expect(fillToWorkspace?.scope).toBe("stella:documents_write");
    expect(fillToWorkspace?.mcp).toEqual({
      type: "covered",
      by: "save_filled_template",
    });
    expect(fillToWorkspace?.permissions).toEqual({
      template: ["use"],
      entity: ["create"],
    });
  });
});
