import { describe, expect, test } from "bun:test";

import { DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS } from "@stll/api-contract";
import capabilityCatalog from "@stll/cli/capability-catalog.json";

import { MCP_DOCUMENTS_RESOURCE_SCOPES } from "@/api/mcp/constants";

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
    for (const id of DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS) {
      const entry = capabilityCatalog.find((c) => c.id === id);
      if (entry === undefined) {
        throw new Error(`Missing upload lifecycle capability: ${id}`);
      }
      expect(entry.access).toBe("write");
      expect(entry.scope).toBe("stella:matters_write");
      expect(
        MCP_DOCUMENTS_RESOURCE_SCOPES.some((scope) => scope === entry.scope),
      ).toBe(true);
    }
  });
});
