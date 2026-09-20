import { McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import {
  FILE_COMPARISON_TRANSPORT,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { LIMITS } from "@/api/lib/limits";
import { MCP_MODES } from "@/api/mcp/constants";
import { DOCUMENT_UPLOAD_APP_RESOURCE_URI } from "@/api/mcp/document-file-upload";
import {
  buildLegislationWorkflowReference,
  LEGISLATION_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/legislation-workflow-reference";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  listStaticMcpToolDefinitions,
  MCP_STATIC_TOOL_NAMES,
} from "@/api/mcp/static-tool-definitions";
import { buildFieldReference } from "@/api/mcp/template-field-reference";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import {
  buildWorkflowReference,
  TEMPLATE_WORKFLOW_TOOL_NAMES,
} from "@/api/mcp/template-workflow-reference";

const MARKER_REFERENCE_URI = "stella://reference/template-markers";
const FIELD_REFERENCE_URI = "stella://reference/template-fields";
const WORKFLOW_REFERENCE_URI = "stella://reference/template-workflow";
const LEGISLATION_WORKFLOW_REFERENCE_URI =
  "stella://reference/legislation-workflow";
const FEEDBACK_WORKFLOW_REFERENCE_URI = "stella://reference/feedback-workflow";
const PRODUCT_IDENTITY_URI = "stella://about";

/** The storage-only CSP every bundled upload panel is served with. */
const expectedUploadAppMeta = (): Record<string, unknown> => {
  const storageEndpoint = new URL(envBase.S3_ENDPOINT);
  if (
    storageEndpoint.hostname.includes("s3") &&
    storageEndpoint.hostname.endsWith(".amazonaws.com") &&
    envBase.S3_BUCKET.length > 0
  ) {
    storageEndpoint.hostname = `${envBase.S3_BUCKET}.${storageEndpoint.hostname}`;
  }
  return {
    ui: {
      csp: { connectDomains: [storageEndpoint.origin], resourceDomains: [] },
      prefersBorder: true,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Every string a tool's advertised JSON Schema declares as an accepted enum
 *  value, at any depth. */
const advertisedEnumValues = (schema: unknown): string[] => {
  if (Array.isArray(schema)) {
    return schema.flatMap(advertisedEnumValues);
  }
  if (!isRecord(schema)) {
    return [];
  }
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "enum" && Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string")
      : advertisedEnumValues(value),
  );
};

describe("MCP resources", () => {
  test("shares the official MCP Apps resource MIME type", () => {
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
  });

  test("lists the public static resources on every matter-bearing surface", () => {
    for (const mode of ["default", "anonymized"] as const) {
      const resources = listMcpResources(mode);
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain(PRODUCT_IDENTITY_URI);
      expect(uris).toContain(MARKER_REFERENCE_URI);
      expect(uris).toContain(FIELD_REFERENCE_URI);
      expect(uris).toContain(WORKFLOW_REFERENCE_URI);
      expect(uris).toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
    }
  });

  test("only a surface that lists both feedback tools serves their workflow", () => {
    const defaultUris = listMcpResources("default").map((r) => r.uri);
    expect(defaultUris).toContain(FEEDBACK_WORKFLOW_REFERENCE_URI);
    // The anonymized surface differs from the default one by exactly this
    // reference: its tools are excluded there, so the procedure is too.
    expect(listMcpResources("anonymized").map((r) => r.uri)).toEqual(
      defaultUris.filter((uri) => uri !== FEEDBACK_WORKFLOW_REFERENCE_URI),
    );
    for (const mode of ["anonymized", "documents", "law"] as const) {
      expect(listMcpResources(mode).map((r) => r.uri)).not.toContain(
        FEEDBACK_WORKFLOW_REFERENCE_URI,
      );
    }
  });

  test("the documents surface drops the reference it cannot drive", () => {
    // The documents audience lists no corpus tool, so every procedure step
    // filters out and the document would be a title with no procedure.
    const uris = listMcpResources("documents").map((resource) => resource.uri);
    expect(uris).not.toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
    expect(uris).toEqual(
      listMcpResources("default")
        .map((resource) => resource.uri)
        .filter(
          (uri) =>
            uri !== LEGISLATION_WORKFLOW_REFERENCE_URI &&
            uri !== FEEDBACK_WORKFLOW_REFERENCE_URI,
        ),
    );
  });

  test("the law surface lists only the identity and the corpus workflow", () => {
    expect(listMcpResources("law").map((resource) => resource.uri)).toEqual([
      PRODUCT_IDENTITY_URI,
      LEGISLATION_WORKFLOW_REFERENCE_URI,
    ]);
  });

  test("the law surface reads exactly what it lists", async () => {
    for (const uri of [
      PRODUCT_IDENTITY_URI,
      LEGISLATION_WORKFLOW_REFERENCE_URI,
    ]) {
      const result = await readMcpResource(uri, "law");
      expect(result.contents.at(0)?.uri).toBe(uri);
    }

    // A reference for a workflow this surface carries no tool for is context an
    // agent pays for and cannot use, so the read refuses it like any unknown
    // uri rather than serving something unlisted.
    for (const uri of [
      MARKER_REFERENCE_URI,
      FIELD_REFERENCE_URI,
      WORKFLOW_REFERENCE_URI,
      DOCUMENT_UPLOAD_APP_RESOURCE_URI,
      FILE_COMPARISON_TRANSPORT.resourceUri,
    ]) {
      let caught: unknown;
      try {
        await readMcpResource(uri, "law");
      } catch (error) {
        caught = error;
      }
      expect(
        caught,
        `${uri} must not be readable on the law surface`,
      ).toBeInstanceOf(ProtocolError);
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
    // the source branches with their allowed keys.
    expect(content.text).toContain('`{ "type": "ai" }`');
    expect(content.text).toContain("`options_from`");
    expect(content.text).toContain("{{path.key}}");
    expect(content.text).toContain('`{ "type": "party" }`');
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
    // names reads as a tool name to an agent, so it must be one — unless it
    // is a value one of those tools actually accepts (`action:
    // "create_document"`). The accepted values are read off the advertised
    // schemas, never hand-listed, so a token stops being excused here the
    // moment the tool stops accepting it.
    const toolVerbs = new Set(
      MCP_STATIC_TOOL_NAMES.map((name) => name.split("_")[0]),
    );
    const advertisedValues = new Set(
      DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((definition) =>
        advertisedEnumValues(definition.inputSchema),
      ),
    );
    const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)]
      .map(([token]) => token)
      .filter((token) => toolVerbs.has(token.split("_")[0] ?? ""));
    expect(
      [...new Set(mentioned)].filter(
        (token) => !registryNames.has(token) && !advertisedValues.has(token),
      ),
    ).toEqual([]);
  });

  test("reads the legislation workflow reference in corpus-reading order", async () => {
    const workflow = listMcpResources("default").find(
      (resource) => resource.uri === LEGISLATION_WORKFLOW_REFERENCE_URI,
    );
    expect(workflow?.mimeType).toBe("text/markdown");

    const result = await readMcpResource(
      LEGISLATION_WORKFLOW_REFERENCE_URI,
      "default",
    );
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.uri).toBe(LEGISLATION_WORKFLOW_REFERENCE_URI);
    expect(content.text).toBe(buildLegislationWorkflowReference());
    // The facts an agent cannot read off the tool list: the ELI is the handle
    // every later call takes, the point-in-time question is answered by the
    // read and not by a search filter, anchors come from the outline, and a
    // withheld text will not come back on a retry.
    expect(content.text).toContain("`as_of`");
    expect(content.text).toContain("`outline`");
    expect(content.text).toContain("`par_1729`");
    expect(content.text).toContain("`text_withheld`");
    expect(content.text).toContain("`textWithheldReason`");
    // Rendered from the enforced limits, never spelled by hand.
    expect(content.text).toContain(String(LIMITS.legislationProvisionBatchMax));
    expect(content.text).toContain(
      String(LIMITS.legislationProvisionTextChars),
    );
    expect(content.text).toContain(
      String(LIMITS.legislationOutlineHeadingsMax),
    );
  });

  test("every tool the legislation reference names is in the registry", () => {
    const text = buildLegislationWorkflowReference();
    const registryNames = new Set<string>(MCP_STATIC_TOOL_NAMES);
    for (const name of LEGISLATION_WORKFLOW_TOOL_NAMES) {
      expect(registryNames.has(name), `${name} is not a registry tool`).toBe(
        true,
      );
      expect(text, `${name} is declared but never named`).toContain(name);
    }

    // Same scan as the template reference, for the other direction: a
    // snake_case token that reads as a tool name to an agent must be one.
    const toolVerbs = new Set(
      MCP_STATIC_TOOL_NAMES.map((name) => name.split("_")[0]),
    );
    const advertisedValues = new Set(
      DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((definition) =>
        advertisedEnumValues(definition.inputSchema),
      ),
    );
    const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)]
      .map(([token]) => token)
      .filter((token) => toolVerbs.has(token.split("_")[0] ?? ""));
    expect(
      [...new Set(mentioned)].filter(
        (token) => !registryNames.has(token) && !advertisedValues.has(token),
      ),
    ).toEqual([]);
  });

  test("the legislation reference names only tools the audience lists", () => {
    // The reference is copied into model context as the complete contract, so
    // a step naming a tool the surface does not carry is a dead end. Scanned
    // the same way the other reference guards in this file scan: a multi-word
    // snake_case token is what reads as a tool name to an agent.
    const registryNames = new Set<string>(MCP_STATIC_TOOL_NAMES);
    const servingModes = MCP_MODES.filter((mode) =>
      listMcpResources(mode).some(
        ({ uri }) => uri === LEGISLATION_WORKFLOW_REFERENCE_URI,
      ),
    );
    expect(servingModes).toEqual(["default", "anonymized", "law"]);

    for (const mode of servingModes) {
      const listed = new Set(
        listStaticMcpToolDefinitions(mode).map(({ name }) => name),
      );
      const unreachable = [
        ...new Set(
          [
            ...buildLegislationWorkflowReference(mode).matchAll(
              /\b[a-z]+(?:_[a-z]+)+\b/gu,
            ),
          ].map(([token]) => token),
        ),
      ].filter((token) => registryNames.has(token) && !listed.has(token));

      expect(
        unreachable,
        `The ${mode} legislation reference names tools that surface does not list`,
      ).toEqual([]);
    }
  });

  test("the law reference keeps the corpus steps and drops the rest", async () => {
    const text = buildLegislationWorkflowReference("law");

    for (const name of [
      "search_legislation",
      "read_statute",
      "read_statute_provisions",
      "read_provision_history",
    ]) {
      expect(text, `${name} is served on the law surface`).toContain(name);
    }
    // The live upstream connector and the feedback tool are not on this
    // surface, so their step and the report line are not rendered.
    expect(text).not.toContain("search_boe_legislation");
    expect(text).not.toContain("prepare_feedback");

    const result = await readMcpResource(
      LEGISLATION_WORKFLOW_REFERENCE_URI,
      "law",
    );
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected a text resource content entry");
    }
    expect(content.text).toBe(text);
  });

  test("every stella:// uri the legislation reference names is a listed resource", () => {
    const listedUris = new Set(
      listMcpResources("default").map((resource) => resource.uri),
    );
    expect(
      [
        ...new Set(
          [
            ...buildLegislationWorkflowReference().matchAll(
              /stella:\/\/[\w/-]+/gu,
            ),
          ].map(([uri]) => uri),
        ),
      ].filter((uri) => !listedUris.has(uri)),
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
    expect(content._meta).toEqual(expectedUploadAppMeta());
  });

  test("serves the bundled file comparison MCP App with storage-only CSP", async () => {
    expect(listMcpResources("default")).not.toContainEqual(
      expect.objectContaining({ uri: FILE_COMPARISON_TRANSPORT.resourceUri }),
    );

    const result = await readMcpResource(
      FILE_COMPARISON_TRANSPORT.resourceUri,
      "default",
    );
    const content = result.contents.at(0);
    if (!content || !("text" in content)) {
      throw new Error("Expected file comparison app HTML");
    }
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("Compare two files");
    expect(content.text).toContain("ui/initialize");
    expect(
      McpUiResourceMetaSchema.safeParse(content._meta?.["ui"]).success,
    ).toBe(true);
    expect(content._meta).toEqual(expectedUploadAppMeta());
  });

  test("lists and reads the legislation workflow only behind its own gate", async () => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    const previousIsDev = env.isDev;
    env.FEATURE_PUBLIC_LAW = false;
    env.isDev = false;
    try {
      // The four corpus tools are filtered out of tools/list on this
      // deployment, so a reference telling a model to call them would hand it
      // a procedure it has no advertised schema for.
      expect(
        listMcpResources("default").map((entry) => entry.uri),
      ).not.toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
      let caught: unknown;
      try {
        await readMcpResource(LEGISLATION_WORKFLOW_REFERENCE_URI, "default");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProtocolError);
      // An ungated reference is unaffected.
      expect(listMcpResources("default").map((entry) => entry.uri)).toContain(
        WORKFLOW_REFERENCE_URI,
      );

      env.FEATURE_PUBLIC_LAW = true;
      expect(listMcpResources("default").map((entry) => entry.uri)).toContain(
        LEGISLATION_WORKFLOW_REFERENCE_URI,
      );
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      env.isDev = previousIsDev;
    }
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
