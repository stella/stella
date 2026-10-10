import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { MCP_MODES } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { getMcpInstructions, MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
import { listMcpResources, readMcpResource } from "@/api/mcp/resources";
import {
  listStaticMcpToolDefinitions,
  REGISTERED_MCP_TOOL_NAMES,
} from "@/api/mcp/static-tool-definitions";
import {
  scopeHintToSurface,
  scopeToolResultToSurface,
  surfaceToolVocabulary,
  unlistedToolNamesIn,
} from "@/api/mcp/surface-tool-mentions";
import { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
import { namedToolNames, scopeProseToSurface } from "@/api/mcp/tool-mentions";
import * as toolUtils from "@/api/mcp/tool-utils";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

/**
 * No surface tells a model to call a tool that surface does not list. The
 * names are read off the registry (every tool any surface lists) and every
 * served text is scanned for any of them, so a mention of another audience's
 * tool fails here whether it sits in a description, an input- or
 * output-schema description, the connect-time instructions, a served
 * reference, or an error hint the dispatch boundary emits.
 */

let previousFeaturePublicLaw: boolean;
beforeEach(() => {
  previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
  // Every gate open: the widest set of texts a surface can serve.
  env.FEATURE_PUBLIC_LAW = true;
});
afterEach(() => {
  env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
});

/** Every `description` string anywhere in a JSON value. */
const descriptionsIn = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(descriptionsIn);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "description" && typeof child === "string"
      ? [child]
      : descriptionsIn(child),
  );
};

const offendersIn = (
  mode: McpMode,
  texts: readonly { where: string; text: string }[],
) =>
  texts.flatMap(({ text, where }) => {
    const unlisted = unlistedToolNamesIn(text, mode);
    return unlisted.length === 0 ? [] : [`${where}: ${unlisted.join(", ")}`];
  });

/** The exported hint constants, found by name so a new one is covered too. */
const HINT_CONSTANTS = Object.entries(toolUtils).flatMap(([name, value]) =>
  name.endsWith("_HINT") && typeof value === "string" ? [{ name, value }] : [],
);

describe("the detector reaches the texts it guards", () => {
  test("the registry-wide name set covers every surface's tools", () => {
    for (const mode of MCP_MODES) {
      for (const { name } of listStaticMcpToolDefinitions(mode)) {
        expect(REGISTERED_MCP_TOOL_NAMES.has(name)).toBe(true);
      }
    }
  });

  test("the shared failure hints name a tool some surface lacks", () => {
    // Otherwise the per-surface assertions below would pass vacuously.
    expect(HINT_CONSTANTS.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "MCP_INTERNAL_ERROR_HINT",
        "MCP_UPSTREAM_UNAVAILABLE_HINT",
      ]),
    );
    for (const hint of [
      toolUtils.MCP_INTERNAL_ERROR_HINT,
      toolUtils.MCP_UPSTREAM_UNAVAILABLE_HINT,
    ]) {
      expect(unlistedToolNamesIn(hint, "law").length).toBeGreaterThan(0);
    }
  });
});

describe("prose scoping", () => {
  const vocabulary = {
    registered: new Set(["search", "read_statute", "prepare_feedback"]),
    listed: new Set(["search", "read_statute"]),
  };

  test("a text naming only listed tools comes back as the same string", () => {
    const text = "Call read_statute.  Then  `search` again.";
    expect(scopeProseToSurface(text, vocabulary)).toBe(text);
  });

  test("only the sentence naming an unlisted tool is dropped", () => {
    expect(
      scopeProseToSurface(
        "Retry once. If it persists, call prepare_feedback. Then read_statute.",
        vocabulary,
      ),
    ).toBe("Retry once. Then read_statute.");
  });

  test("a single-word name counts only when backticked", () => {
    const loose = { ...vocabulary, listed: new Set<string>() };
    expect(namedToolNames("run the search", loose.registered)).toEqual([]);
    expect(namedToolNames("call `search`", loose.registered)).toEqual([
      "search",
    ]);
  });

  test("nothing survives when every sentence names an unlisted tool", () => {
    expect(
      scopeProseToSurface("Draft with prepare_feedback.", vocabulary),
    ).toBeUndefined();
  });

  // A surface without the feedback tools still gets a step it can take.
  test("the scoped internal-error hint keeps a recovery step", () => {
    const scoped = scopeToolResultToSurface(
      toolUtils.structuredErrorResult({
        code: "internal_error",
        message: "Tool execution failed",
        hint: toolUtils.MCP_INTERNAL_ERROR_HINT,
      }),
      { mode: "law" },
    );
    expect(scoped.status === "error" && scoped.error).toEqual({
      type: "structured",
      code: "internal_error",
      [MCP_INTERNAL_TOOL_FAILURE]: true,
      message: "Tool execution failed",
      hint: "This is a server-side failure; changing the arguments will not fix it. Tell the human this step failed on the server, then continue without it.",
    });
  });

  test("a scoped error drops the hint key rather than serving an empty one", () => {
    const result = toolUtils.structuredErrorResult({
      code: "internal_error",
      message: "Tool execution failed",
      hint: "Draft a report with prepare_feedback.",
    });
    const scoped = scopeToolResultToSurface(result, { mode: "law" });
    expect(scoped.status === "error" && scoped.error).toEqual({
      type: "structured",
      code: "internal_error",
      [MCP_INTERNAL_TOOL_FAILURE]: true,
      message: "Tool execution failed",
    });
  });
});

describe.each(MCP_MODES.map((mode) => ({ mode })))(
  "the $mode surface names only tools it lists",
  ({ mode }) => {
    test("in every tool description and schema description", () => {
      const tools = toMcpTools(listStaticMcpToolDefinitions(mode), { mode });
      const texts = tools.flatMap((tool) =>
        descriptionsIn(tool).map((text) => ({ where: tool.name, text })),
      );
      expect(texts.length).toBeGreaterThan(0);
      expect(offendersIn(mode, texts)).toEqual([]);
    });

    test("in the connect-time instructions, gate open or closed", () => {
      const texts = [{ where: "max", text: MCP_INSTRUCTIONS[mode] }];
      for (const gate of [true, false]) {
        env.FEATURE_PUBLIC_LAW = gate;
        texts.push({ where: `gate=${gate}`, text: getMcpInstructions(mode) });
      }
      expect(offendersIn(mode, texts)).toEqual([]);
    });

    test("in every reference resource it serves", async () => {
      const texts: { where: string; text: string }[] = [];
      for (const resource of listMcpResources(mode)) {
        texts.push({
          where: resource.uri,
          text: resource.description ?? "",
        });
        const read = await readMcpResource(resource.uri, mode);
        for (const content of read.contents) {
          if ("text" in content && resource.mimeType !== "text/html") {
            texts.push({ where: resource.uri, text: content.text });
          }
        }
      }
      expect(offendersIn(mode, texts)).toEqual([]);
    });

    test("and points only at reference resources it serves", () => {
      const served = new Set(listMcpResources(mode).map(({ uri }) => uri));
      const texts = [
        MCP_INSTRUCTIONS[mode],
        ...toMcpTools(listStaticMcpToolDefinitions(mode), { mode }).flatMap(
          descriptionsIn,
        ),
      ];
      const pointers = texts.flatMap((text) =>
        [...text.matchAll(/stella:\/\/[a-z0-9/_-]*[a-z0-9]/gu)].map(
          ([uri]) => uri,
        ),
      );
      expect(pointers.filter((uri) => !served.has(uri))).toEqual([]);
    });

    test("in every shared hint once scoped, which still states a next step", () => {
      for (const { name, value } of HINT_CONSTANTS) {
        const scoped = scopeHintToSurface(value, { mode });
        expect({ name, scoped: scoped ?? "" }).toMatchObject({
          name,
          scoped: expect.stringMatching(/\S/u),
        });
        expect(unlistedToolNamesIn(scoped ?? "", mode)).toEqual([]);
      }
    });
  },
);

describe("the dispatch boundary scopes the hints it emits", () => {
  // Every DB seam throws, so the handler fails on its first query and the
  // central pipeline answers with its internal-failure envelope.
  const throwingScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(() => {
    throw new Error("database unavailable");
  });
  const failingContext = (): McpRequestContext => ({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: ["stella:search", "stella:read"],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw(async () => undefined),
    safeDb: toSafeDbMock(throwingScopedDb),
    scopedDb: throwingScopedDb,
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });

  const INTERNAL_ERROR_ENVELOPE = v.object({
    error: v.object({
      code: v.literal("internal_error"),
      hint: v.optional(v.string()),
    }),
  });

  const hintOf = async (mode: McpMode) => {
    const result = await handleMcpToolCall({
      args: { query: "promlčení" },
      context: failingContext(),
      mode,
      toolName: "search",
    });
    const item = result.content.at(0);
    if (item?.type !== "text") {
      throw new Error("expected a text envelope");
    }
    return v.parse(INTERNAL_ERROR_ENVELOPE, JSON.parse(item.text)).error.hint;
  };

  test("the law surface keeps the server-side step and drops the report step", async () => {
    const hint = await hintOf("law");
    expect(hint).toBe(
      scopeHintToSurface(toolUtils.MCP_INTERNAL_ERROR_HINT, { mode: "law" }),
    );
    expect(unlistedToolNamesIn(hint ?? "", "law")).toEqual([]);
    expect(hint).not.toContain("prepare_feedback");
  });

  test("the default surface still points at the feedback tools it lists", async () => {
    expect(
      surfaceToolVocabulary("default").listed.has("prepare_feedback"),
    ).toBe(true);
    expect(await hintOf("default")).toBe(toolUtils.MCP_INTERNAL_ERROR_HINT);
  });
});
