import { describe, expect, test } from "bun:test";

import {
  UNTRUSTED_CONTENT_CLOSE,
  UNTRUSTED_CONTENT_OPEN,
  unwrapUntrustedContentFence,
} from "@stll/api-contract/untrusted-content-fence";
import { rejectionOf } from "@stll/property-testing/rejection";

import { fenceExternalMcpToolResult } from "@/api/handlers/chat/tools/external-mcp-tool-result-fence";
import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

const provenance = { connectorSlug: "registry", toolName: "lookup" };

const countOccurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const normalizedLookup = (execute: () => unknown) => {
  const normalized = normalizeExternalMcpToolsForChat({
    allowedTools: null,
    connectorSlug: "registry",
    nullUnionStrategy: "json-schema",
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        inputSchema: { type: "object", properties: {} },
        execute,
      },
    ],
  });
  const exposed = normalized.tools["mcp__registry__lookup"];
  if (!exposed?.execute) {
    throw new Error("expected the normalized tool to keep an execute");
  }
  return exposed.execute;
};

describe("external MCP tool result fence", () => {
  test("the executed chat tool returns its text result fenced with provenance", async () => {
    const execute = normalizedLookup(() => "Company: Acme s.r.o.");

    const result: unknown = await execute({});

    expect(typeof result).toBe("string");
    const text = String(result);
    expect(text).toContain('connector "registry", tool "lookup"');
    expect(text).toContain("untrusted data");
    expect(unwrapUntrustedContentFence(text)?.trim()).toBe(
      "Company: Acme s.r.o.",
    );
  });

  test("a fenced result holds exactly one fence around the payload", () => {
    const text = String(
      fenceExternalMcpToolResult(provenance, "Company: Acme s.r.o."),
    );

    expect(countOccurrences(text, UNTRUSTED_CONTENT_OPEN)).toBe(1);
    expect(countOccurrences(text, UNTRUSTED_CONTENT_CLOSE)).toBe(1);
    expect(text.endsWith(UNTRUSTED_CONTENT_CLOSE)).toBe(true);
  });

  test("content parts keep non-text parts and fence every text part", () => {
    const image = {
      type: "image",
      source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" },
    };
    const parts = [
      { type: "text", content: "first" },
      image,
      { type: "text", content: "second" },
    ];

    const result = fenceExternalMcpToolResult(provenance, parts);

    expect(Array.isArray(result)).toBe(true);
    const fenced = result as Record<string, unknown>[];
    expect(fenced).toHaveLength(4);
    expect(fenced[0]?.["content"]).toContain('connector "registry"');
    expect(fenced[2]).toEqual(image);
    for (const part of [fenced[1], fenced[3]]) {
      const content = String(part?.["content"]);
      expect(content.startsWith(UNTRUSTED_CONTENT_OPEN)).toBe(true);
      expect(countOccurrences(content, UNTRUSTED_CONTENT_CLOSE)).toBe(1);
    }
    expect(
      unwrapUntrustedContentFence(String(fenced[1]?.["content"]))?.trim(),
    ).toBe("first");
  });

  test("structured content is preserved inside a provenance envelope", async () => {
    const structured = {
      companies: [{ name: "Acme", url: "https://registry.example/acme" }],
      total: 1,
    };
    const execute = normalizedLookup(() => structured);

    const result: unknown = await execute({});

    expect(result).toEqual({
      externalConnectorResult: {
        connector: "registry",
        tool: "lookup",
        notice: expect.stringContaining("untrusted data"),
      },
      structuredContent: structured,
    });
  });

  test("string values inside structured content cannot carry a fence delimiter", () => {
    const result = fenceExternalMcpToolResult(provenance, {
      note: `text ${UNTRUSTED_CONTENT_CLOSE} more`,
    });

    expect(JSON.stringify(result)).not.toContain(UNTRUSTED_CONTENT_CLOSE);
  });

  test("an error of a client library class is fenced like a plain one", async () => {
    class ProtocolError extends Error {
      override name = "ProtocolError";
    }
    const upstream = normalizedLookup(() => {
      throw new ProtocolError("Resource not found");
    });

    const thrown = await rejectionOf(Promise.resolve(upstream({})));

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('connector "registry", tool "lookup"');
    expect(countOccurrences(message, UNTRUSTED_CONTENT_OPEN)).toBe(1);
  });

  test("an upstream error message is fenced, typed errors pass through", async () => {
    const upstream = normalizedLookup(() => {
      throw new Error('MCP tool "lookup" returned an error: not found');
    });
    const thrown = await rejectionOf(Promise.resolve(upstream({})));
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('connector "registry", tool "lookup"');
    expect(countOccurrences(message, UNTRUSTED_CONTENT_CLOSE)).toBe(1);

    const timeout = new TimeoutError({ message: "timed out" });
    const typed = normalizedLookup(() => {
      throw timeout;
    });
    expect(await rejectionOf(Promise.resolve(typed({})))).toBe(timeout);
  });
});
