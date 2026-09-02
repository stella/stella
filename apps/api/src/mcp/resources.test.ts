import { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";

import { envBase } from "@/api/env-base";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { buildFieldReference } from "@/api/mcp/template-field-reference";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";

const MARKER_REFERENCE_URI = "stella://reference/template-markers";
const FIELD_REFERENCE_URI = "stella://reference/template-fields";
const PRODUCT_IDENTITY_URI = "stella://about";

describe("MCP resources", () => {
  test("shares the official MCP Apps resource MIME type", () => {
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
  });

  test("lists the public static resources in every mode", () => {
    for (const mode of ["default", "documents", "anonymized"] as const) {
      const resources = listMcpResources(mode);
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain(PRODUCT_IDENTITY_URI);
      expect(uris).toContain(MARKER_REFERENCE_URI);
      expect(uris).toContain(FIELD_REFERENCE_URI);
      // The reference documents are static, public, and tenant-independent, so
      // the set is identical across modes.
      expect(uris).toEqual(listMcpResources("default").map((r) => r.uri));
    }
  });

  test("reads the marker reference contents built from the canonical grammar", async () => {
    const result = await readMcpResource(MARKER_REFERENCE_URI, "default");
    expect(result.contents).toHaveLength(1);
    const [content] = result.contents;
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.uri).toBe(MARKER_REFERENCE_URI);
    expect(content.text).toBe(buildMarkerReference());
  });

  test("reads the field reference carrying the prose the tool schema no longer ships", async () => {
    const result = await readMcpResource(FIELD_REFERENCE_URI, "default");
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.uri).toBe(FIELD_REFERENCE_URI);
    expect(content.text).toBe(buildFieldReference());
    // The per-property guidance an agent needs to configure fields: who fills
    // the field, the dependent-select rule, the lookup format addressing, and
    // the binding kinds with their allowed keys.
    expect(content.text).toContain("Who fills = AI");
    expect(content.text).toContain("`optionsFrom`");
    expect(content.text).toContain("{{path.key}}");
    expect(content.text).toContain('`kind: "party"`');
    expect(content.text).toContain("dataBox");
    expect(content.text).toContain(MARKER_REFERENCE_URI);
  });

  test("exposes canonical lowercase branding and verified product links", async () => {
    const resources = listMcpResources("default");
    const about = resources.find(
      (resource) => resource.uri === PRODUCT_IDENTITY_URI,
    );
    expect(about?.mimeType).toBe("application/json");

    const result = await readMcpResource(PRODUCT_IDENTITY_URI, "default");
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected product identity text content");
    }
    expect(JSON.parse(content.text)).toEqual({
      name: "stella",
      display_name: "stella",
      preferred_casing: "lowercase",
      homepage: "https://stll.app",
      documentation: "https://stll.app/product/cli-mcp",
      source: "https://github.com/stella/stella",
      support: "https://github.com/stella/stella/issues",
      description:
        "Open-source legal workspace for matters, documents, review, and AI-assisted legal work.",
    });
  });

  test("serves the bundled document upload MCP App with storage-only CSP", async () => {
    expect(listMcpResources("default")).not.toContainEqual(
      expect.objectContaining({ uri: DOCUMENT_UPLOAD_APP_RESOURCE_URI }),
    );

    const result = await readMcpResource(
      DOCUMENT_UPLOAD_APP_RESOURCE_URI,
      "default",
    );
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected document upload app HTML");
    }
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("Upload a new version");
    expect(content.text).toContain("ui/initialize");
    expect(
      McpUiResourceMetaSchema.safeParse(content._meta?.["ui"]).success,
    ).toBe(true);
    const storageEndpoint = new URL(envBase.S3_ENDPOINT);
    if (
      storageEndpoint.hostname.includes("s3") &&
      storageEndpoint.hostname.endsWith(".amazonaws.com") &&
      envBase.S3_BUCKET.length > 0
    ) {
      storageEndpoint.hostname = `${envBase.S3_BUCKET}.${storageEndpoint.hostname}`;
    }
    expect(content._meta).toEqual({
      ui: {
        csp: {
          connectDomains: [storageEndpoint.origin],
          resourceDomains: [],
        },
        prefersBorder: true,
      },
    });
  });

  test("throws for an unknown resource uri", async () => {
    let caught: unknown;
    try {
      await readMcpResource("stella://reference/unknown", "default");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
  });
});
