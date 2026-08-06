import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { DIRECTIVE_KINDS } from "@stll/template-conditions";

import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";

const MARKER_REFERENCE_URI = "stella://reference/template-markers";
const PRODUCT_IDENTITY_URI = "stella://about";

describe("MCP resources", () => {
  test("lists the public static resources in both modes", () => {
    for (const mode of ["default", "anonymized"] as const) {
      const resources = listMcpResources(mode);
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain(PRODUCT_IDENTITY_URI);
      expect(uris).toContain(MARKER_REFERENCE_URI);
      // The marker reference is static, public, and tenant-independent, so the
      // set is identical across modes.
      expect(uris).toEqual(listMcpResources("default").map((r) => r.uri));
    }
  });

  test("reads the marker reference contents built from the canonical grammar", () => {
    const result = readMcpResource(MARKER_REFERENCE_URI, "default");
    expect(result.contents).toHaveLength(1);
    const [content] = result.contents;
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.uri).toBe(MARKER_REFERENCE_URI);
    expect(content.text).toBe(buildMarkerReference());
  });

  test("exposes canonical lowercase branding and verified product links", () => {
    const resources = listMcpResources("default");
    const about = resources.find(
      (resource) => resource.uri === PRODUCT_IDENTITY_URI,
    );
    expect(about?.mimeType).toBe("application/json");

    const result = readMcpResource(PRODUCT_IDENTITY_URI, "default");
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

  test("the marker reference covers every canonical directive kind", () => {
    const result = readMcpResource(MARKER_REFERENCE_URI, "default");
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected marker reference text content");
    }
    const { text } = content;
    // Every canonical directive kind from markers.ts must be documented, so the
    // reference can never silently drift from the grammar.
    for (const kind of DIRECTIVE_KINDS) {
      expect(text).toContain(kind);
    }
  });

  test("throws for an unknown resource uri", () => {
    expect(() =>
      readMcpResource("stella://reference/unknown", "default"),
    ).toThrow(ProtocolError);
  });
});
