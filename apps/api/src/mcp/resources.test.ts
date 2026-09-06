import { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";

import { envBase } from "@/api/env-base";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-definitions";
import { buildFieldReference } from "@/api/mcp/template-field-reference";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import {
  buildWorkflowReference,
  TEMPLATE_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/template-workflow-reference";

const MARKER_REFERENCE_URI = "stella://reference/template-markers";
const FIELD_REFERENCE_URI = "stella://reference/template-fields";
const WORKFLOW_REFERENCE_URI = "stella://reference/template-workflow";
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
      expect(uris).toContain(WORKFLOW_REFERENCE_URI);
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
    expect(content.text).toContain("`options_from`");
    expect(content.text).toContain("{{path.key}}");
    expect(content.text).toContain('`kind: "party"`');
    expect(content.text).toContain("dataBox");
    expect(content.text).toContain(MARKER_REFERENCE_URI);
  });

  test("reads the workflow reference describing the create-then-configure order", async () => {
    const workflow = listMcpResources("default").find(
      (resource) => resource.uri === WORKFLOW_REFERENCE_URI,
    );
    expect(workflow?.mimeType).toBe("text/markdown");

    const result = await readMcpResource(WORKFLOW_REFERENCE_URI, "default");
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.uri).toBe(WORKFLOW_REFERENCE_URI);
    expect(content.text).toBe(buildWorkflowReference());
    // The steps an agent cannot read off the tool list: create and configure
    // are two calls, the discovered paths are read back in between, and the
    // fill is previewed before anything is persisted.
    expect(content.text).toContain("`docx_base64`");
    expect(content.text).toContain("`arrays[]`");
    expect(content.text).toContain("`output_mode`");
    expect(content.text).toContain("`completion_mode`");
    expect(content.text).toContain("`idempotency_key`");
  });

  // The workflow document names tools and resources by hand; these two checks
  // are what stop it from outliving them. Tool names render from a list typed
  // against the registry union, so a rename is already a compile error; the
  // scan below catches the other direction, a name written into the prose that
  // the registry never had.
  test("every tool the workflow reference names is in the registry", () => {
    const text = buildWorkflowReference();
    const registryNames = new Set<string>(MCP_STATIC_TOOL_NAMES);
    for (const name of TEMPLATE_WORKFLOW_TOOL_NAMES) {
      expect(registryNames.has(name), `${name} is not a registry tool`).toBe(
        true,
      );
      expect(text, `${name} is declared but never named`).toContain(name);
    }

    // Any snake_case token opening with a verb the registry uses for tool
    // names reads as a tool name to an agent, so it must be one.
    const toolVerbs = new Set(
      MCP_STATIC_TOOL_NAMES.map((name) => name.split("_")[0]),
    );
    const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)]
      .map(([token]) => token)
      .filter((token) => toolVerbs.has(token.split("_")[0] ?? ""));
    expect(
      [...new Set(mentioned)].filter((token) => !registryNames.has(token)),
    ).toEqual([]);
  });

  test("every stella:// uri the workflow reference names is a listed resource", () => {
    const listedUris = new Set(
      listMcpResources("default").map((resource) => resource.uri),
    );
    const mentioned = [
      ...buildWorkflowReference().matchAll(/stella:\/\/[\w/-]+/gu),
    ].map(([uri]) => uri);
    expect(mentioned.length).toBeGreaterThan(0);
    expect(
      [...new Set(mentioned)].filter((uri) => !listedUris.has(uri)),
    ).toEqual([]);
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
