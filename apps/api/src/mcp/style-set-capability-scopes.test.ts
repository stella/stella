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

describe("write capabilities behind an internal authorization guard", () => {
  test("the upload lifecycle stays a write, so a read scope cannot upload", () => {
    // uploads.* mint presigned PUT URLs and finalize/abort file writes, but
    // their ROUTE permission is only `workspace:["read"]` (the real write check
    // is `authorizeUploadPurpose`, inside the handler). Verb classification
    // therefore reads them as `read`; an ACCESS_OVERRIDE pins them to `write`.
    // Since read capabilities resolve to `stella:read`, dropping that override
    // would let a read-only consent perform file writes — so pin it here.
    for (const id of ["uploads.create", "uploads.update", "uploads.delete"]) {
      const entry = capabilityCatalog.find((c) => c.id === id);
      expect(entry?.access).toBe("write");
      expect(entry?.scope).toBe("stella:matters_write");
    }
  });
});
