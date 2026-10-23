import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isRecord } from "@/api/lib/type-guards";

import {
  decorateWebHandoffLinks,
  handoffLinkResult,
  webHandoffPaths,
} from "./web-handoff-links-core";

const base = "https://app.example";

describe("MCP web handoff result links", () => {
  test("collects public and matter links while preserving corpus text and publisher links", () => {
    const body = `Quoted content ${base}/workspaces/other`;
    const data = {
      results: [
        { url: `${base}/workspaces/matter`, body },
        {
          appUrl: `${base}/law/cz/2020/1?version=current#section=2`,
          sourceUrl: "https://publisher.example/law",
        },
      ],
      count: 2,
    };
    const result = {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
      _meta: { openUrl: `${base}/workspaces/matter` },
    } satisfies CallToolResult;
    const links = webHandoffPaths(result, base);
    expect([...new Set(links.values())]).toEqual([
      "/workspaces/matter",
      "/law/cz/2020/1?version=current",
    ]);
    const decorated = decorateWebHandoffLinks(result, links, "sh1_example");
    expect(decorated.structuredContent).toEqual({
      results: [
        { url: `${base}/workspaces/matter#sh=sh1_example`, body },
        {
          appUrl: `${base}/law/cz/2020/1?version=current#section=2&sh=sh1_example`,
          sourceUrl: "https://publisher.example/law",
        },
      ],
      count: 2,
    });
    expect(decorated.content.at(0)).toEqual({
      type: "text",
      text: JSON.stringify(decorated.structuredContent),
    });
    expect(result.structuredContent).toEqual(data);
  });

  test("collects markdown links without rewriting surrounding prose", () => {
    const result = {
      content: [
        {
          type: "text",
          text: `Open [matter](${base}/workspaces/matter). Plain quoted URL: ${base}/workspaces/quote`,
        },
      ],
    } satisfies CallToolResult;
    const links = webHandoffPaths(result, base);
    expect([...links.values()]).toEqual(["/workspaces/matter"]);
    expect(
      decorateWebHandoffLinks(result, links, "sh1_example").content.at(0),
    ).toEqual({
      type: "text",
      text: `Open [matter](${base}/workspaces/matter#sh=sh1_example). Plain quoted URL: ${base}/workspaces/quote`,
    });
  });

  test("keeps unrelated origins and URL credentials outside the path set", () => {
    expect(
      webHandoffPaths(
        {
          url: "https://someone@app.example/workspaces/matter",
          sourceUrl: "https://publisher.example/law",
        },
        base,
      ).size,
    ).toBe(0);
  });
  test("mints once for the complete result and preserves plain results on refusal", async () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ url: `${base}/law/cz/2020/1` }),
        },
      ],
      structuredContent: {
        appUrl: `${base}/workspaces/matter`,
        repeatedUrl: `${base}/law/cz/2020/1`,
      },
    } satisfies CallToolResult;
    const calls: (readonly string[])[] = [];
    const decorated = await handoffLinkResult({
      result,
      appBaseUrl: base,
      mint: async (paths) => {
        calls.push(paths);
        return "sh1_example";
      },
    });
    expect(calls).toEqual([["/workspaces/matter", "/law/cz/2020/1"]]);
    const structuredContent = decorated.structuredContent;
    if (!isRecord(structuredContent)) {
      expect.unreachable("Expected decorated structured content");
    }
    expect(structuredContent["appUrl"]).toBe(
      `${base}/workspaces/matter#sh=sh1_example`,
    );
    expect(
      await handoffLinkResult({
        result,
        appBaseUrl: base,
        mint: async () => null,
      }),
    ).toBe(result);
  });
  test("preserves bare citation anchors and decorates onboarding next steps", async () => {
    const data = {
      appUrl: `${base}/law/cz/2020/1#section-2`,
      nextStep: `Complete onboarding at ${base}.`,
      body: `${base}/workspaces/quoted`,
    };
    const result = { content: [], structuredContent: data };
    const decorated = await handoffLinkResult({
      result,
      appBaseUrl: base,
      mint: async (paths) => {
        expect(paths).toEqual(["/law/cz/2020/1", "/"]);
        return "sh1_example";
      },
    });
    expect(decorated.structuredContent).toEqual({
      appUrl: `${base}/law/cz/2020/1#section-2&sh=sh1_example`,
      nextStep: `Complete onboarding at ${base}/#sh=sh1_example.`,
      body: data.body,
    });
  });
  test("structured handoff links preserve path query and citation fragment bytes", () => {
    assertProperty(
      "structured handoff links preserve path query and citation fragment bytes",
      fc.property(
        fc.string(),
        fc.constantFrom(".", ",", ";", ")", "]", "}", ".)", "%2E"),
        fc.constantFrom("", "section-2", "section-2.", "paragraph=48)"),
        (query, suffix, fragment) => {
          const original = new URL(`${base}/law/example`);
          original.search = `q=${encodeURIComponent(query)}${suffix}`;
          original.hash = fragment;
          const data = { appUrl: original.href };
          const result = { content: [], structuredContent: data };
          const links = webHandoffPaths(result, base);
          expect([...links.values()]).toEqual([
            original.pathname + original.search,
          ]);
          const decorated = decorateWebHandoffLinks(
            result,
            links,
            "sh1_example",
          );
          const structuredContent = decorated.structuredContent;
          if (!isRecord(structuredContent)) {
            expect.unreachable("Expected decorated structured content");
          }
          const value = structuredContent["appUrl"];
          expect(typeof value).toBe("string");
          if (typeof value !== "string") {
            expect.unreachable("Expected a decorated URL");
          }
          const parsed = new URL(value);
          expect(parsed.pathname + parsed.search).toBe(
            original.pathname + original.search,
          );
          expect(parsed.hash).toBe(
            `${original.hash || "#"}${original.hash ? "&" : ""}sh=sh1_example`,
          );
          expect(new URLSearchParams(parsed.hash.slice(1)).get("sh")).toBe(
            "sh1_example",
          );
        },
      ),
    );
  });
});
